// 1.2.0 P1 (spec docs/superpowers/specs/2026-09-20-1.2.0-context-design.md,
// "P1 — the rules file as a map"): the rules file keeps every rule byte for byte
// and loses only the prose that explained how the handoff hooks work, which now
// lives in CONFIG "The handoff hooks". These tests pin both halves: what left the
// rules, and where it went.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MERGE_SENTENCES, renderRulesFile } from '../core/rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** The rules file as a session loads it: rendered, under the default merge policy. */
const rules = () => renderRulesFile('1.2.0', { merge: 'session' });

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

/** How the handoff hooks work, in the words that carry it: CONFIG's to say, never the rules'. */
const MECHANICS = ['40 lines', '4 KB', '12 KB', '8 KB', 'PreCompact', 'SessionStart', 'PostToolUse', 'PostCompact', 'Stop'];

test('CONFIG carries the handoff hooks the rules file used to explain', () => {
  const md = read('docs/CONFIG.md');
  const hooks = section(md, '## The handoff hooks');
  for (const mechanism of MECHANICS) assert.ok(hooks.includes(mechanism), `CONFIG "The handoff hooks" carries: ${mechanism}`);
  for (const event of ['PreCompact', 'SessionStart', 'PostToolUse', 'Stop', 'PostCompact']) {
    assert.ok(hooks.includes(`\`${event}\``), `${event} named`);
  }
  for (const fact of [
    '<session cwd>/.omelette/ledger-*.md',
    'a ledger kept in another repository gets neither the stamp nor the print',
    '40 lines / 4 KB per ledger, 12 KB in all',
    '## Compaction summary <ISO> (trigger: …)',
    'Bounded to 8 KB',
    '`handoff.compactSummary=false`',
    '`handoff.enabled=false`',
    'remind **once** and gate **once** per crossing',
    'the handoff block is still yours to write',
    'A manual `/compact` below the threshold gets no reminder',
    'handoffs at every natural pause, and the hook is the net under it',
  ]) assert.ok(hooks.includes(fact), `CONFIG "The handoff hooks" says: ${fact}`);
  assert.match(md, /^\| .+ \| \[The handoff hooks\]\(#the-handoff-hooks\) \|$/m, 'the map at the top links it');
});

// ── the rules file: explanation out, every rule kept ─────────────────────────

/** Every heading the 1.1.0 file had. */
const HEADINGS = [
  '# Working with the omelette fleet',
  '## Operating model for the session',
  '## Ledger and handoff',
  '## Tester flow',
  '## Reviews',
  '## Spawning sub-agents: model and effort',
  '## Routing',
  '## Never a sole source',
  '## Briefing a unit',
];

/** The two bullets test/evidence-pointers.test.mjs pins, byte for byte as 1.1.0 shipped them. */
const EVIDENCE = '- **Evidence travels with pointers.** Coder and tester reports come as `TASK / FINDINGS / DIFF / TEST RESULTS / OPEN QUESTIONS`, each finding a pointer line — `path:line` (relative to the project root, one line) · a verbatim fragment in backticks · the claim. `omelette-fleet check <file>` verifies the pointers: check before you trust.';
const SCOUT = '- **One scout map per release, never to a first review.** Before planning several packages, one read-only scout writes `.omelette/map-<plan>.md` — `commit: <hash>`, factual pointer lines, a closing `## Not read` — and the planners get it instead of re-reading. Run `check` on it, open three pointers yourself, re-take stale lines.';

/**
 * The five obligations the three hook bullets carried, each by its full
 * sentence as the 1.1.0 text words it (a sentence that opened mid-bullet
 * gains its capital letter, nothing else), and each a bullet of its own.
 */
const DUTIES = [
  '**After a compaction, re-read the ledger before doing anything else.**',
  '**A ledger kept in another repository gets neither the stamp nor the print.**',
  'The handoff block is still yours to write.',
  'A manual `/compact` below the threshold gets no reminder.',
  'The discipline is unchanged: handoffs at every natural pause, and the hook is the net under it.',
];

// 1.3.0 P1: 13 100 -> 13 510 — the measured render with the reviewer's rules
// lines and the three count-free lines (13 413 characters under `session`,
// 13 381 under `pr`) plus about a hundred characters of headroom. The number
// follows the content; the lines themselves are pinned whole below.
// 1.3.0 P2: 13 510 -> 13 620 — the definitions line and the guard sentence
// name the medium coder (+104: 13 517 / 13 485), plus headroom.
// 1.3.0 P2: 13 620 -> 14 030 — the coder line's bucket clause (+405: 13 922 /
// 13 890), plus headroom.
test('the rendered rules file is at most 14 030 characters under either merge policy', () => {
  for (const merge of ['session', 'pr']) {
    const text = renderRulesFile('1.2.0', { merge });
    assert.ok(text.length <= 14030, `${merge}: ${text.length} characters`);
  }
});

test('the rules keep every heading and the two evidence bullets byte for byte', () => {
  const lines = rules().split('\n');
  for (const h of HEADINGS) assert.ok(lines.includes(h), `heading kept: ${h}`);
  assert.ok(lines.includes(EVIDENCE), 'the evidence bullet is unchanged');
  assert.ok(lines.includes(SCOUT), 'the scout-map bullet is unchanged');
});

test('"Ledger and handoff" states the five hook obligations in full, one line each, and points at CONFIG for the rest', () => {
  const text = rules();
  const lines = section(text, '## Ledger and handoff').split('\n');
  for (const duty of DUTIES) assert.ok(lines.includes(`- ${duty}`), `a line of its own: ${duty}`);
  const wiring = lines.filter((l) => l.includes('rules --hooks`'));
  assert.equal(wiring.length, 1, 'one sentence says what `rules --hooks` wires');
  assert.ok(wiring[0].includes('docs/CONFIG.md'), 'and points at CONFIG');
  for (const mechanism of MECHANICS) assert.ok(!text.includes(mechanism), `mechanism moved out of the rules: ${mechanism}`);
});

// ── 1.2.0 P2: what each agent is handed ──────────────────────────────────────

/**
 * P2's rules for the operating model (spec "P2 — briefing from the map", and
 * the principle the release measured), as the template words them. Each is
 * pinned as a whole line: a condition dropped from one fails here, where a
 * substring pin would stay green. They follow the scout-map bullet, whose map
 * they are about.
 */
const HANDED = [
  "- A planner gets the map and its spec section: map first, three pointers opened by hand (one false: whole map unverified), then only what the map lacks; the plan header lists map lines relied on and re-taken.",
  "- A coder gets its task's plan section and pointers, not the spec, whose path covers what the plan left open. Brief `omelette-coder-medium` when the section prints the exact text, diff, tests and expected numbers (the coder executes), `omelette-coder` otherwise (a new thing with no written shape, debugging with no known cause, a decision the brief explicitly delegates); a brief leaving a required decision open gets `NEEDS_CONTEXT` at any effort; the bucket and its reason go into the brief and the ledger line.",
  "- Pay for judgement, not for repetition: planners do not dry-run plans.",
];

test('the operating model says what a planner and a coder are handed, and what the session pays for, right after the scout map', () => {
  const lines = section(rules(), '## Operating model for the session').split('\n');
  const scout = lines.indexOf(SCOUT);
  assert.notEqual(scout, -1, 'the scout-map bullet is in the operating model');
  assert.deepEqual(lines.slice(scout + 1, scout + 1 + HANDED.length), HANDED, 'the three lines follow the scout-map bullet');
});

/**
 * How the session reviews a plan (spec P2, the third rule), a whole line of
 * "Reviews", after the two rules it rests on: the four-part finding with its
 * ledger ruling, and the clean first review.
 */
const PLAN_REVIEW = "- Review a plan by header, task list and Self-Review; a unit gets the full file (spec, plan, four-part findings); open the findings' pointers, not the file.";

test('"Reviews" says how the session reviews a plan, after the four-part finding and the clean first review', () => {
  const lines = section(rules(), '## Reviews').split('\n');
  const at = lines.indexOf(PLAN_REVIEW);
  assert.notEqual(at, -1, 'Reviews has the plan-review rule as a line of its own');
  const four = lines.findIndex((l) => l.startsWith('- **A finding has four parts, or it is a question.**'));
  const clean = lines.findIndex((l) => l.startsWith('- **First review clean, re-review continued.**'));
  assert.ok(four !== -1 && clean !== -1 && four < at && clean < at, 'it follows the two rules it rests on');
});

/**
 * ORCHESTRATION's list under "Evidence with pointers" (spec P2): the same three
 * rules and the principle, in the spec's full wording, each a whole line. The
 * rules file says each in one line; this is where the full text lives.
 */
const HANDED_DOC = [
  "- **A planner starts from the map.** Its brief carries the scout map's path and the package's section of the spec, and says: read the map first; open three of its pointers yourself before relying on it, and if one is false treat the whole map as unverified; then open only what the map does not cover; record in the plan's header which map lines you relied on and which you re-took. If you keep a planner definition of your own (none ships), give it the same sentence.",
  "- **A coder gets its task, not the release.** Its brief carries the task's section of the plan and the pointers it needs, not the whole spec; the spec's path is there for the cases the plan did not settle. The brief also names which coder, by how much the section leaves to decide. **`omelette-coder-medium`** (`effort: medium`) when the section prints the exact text, the diff, the tests and the numbers they must print: the coder executes it, and on one plan-driven trial medium built the same behaviour as xhigh, which took 2.5× the cache reads and 3.6× the wall clock ([MEASUREMENTS](MEASUREMENTS.md#coder-effort-medium-high-xhigh-on-one-task), N = 1). **`omelette-coder`** (`effort: xhigh`) otherwise: a new thing with no written shape, debugging with no known cause, or a decision the brief *explicitly delegates* (decide X between A and B, report the trade-off) — effort buys depth on the decisions the brief hands over, not permission to guess. A brief that leaves a required decision open gets `NEEDS_CONTEXT` back at any effort: the coder template says so, and neither bucket changes it. The bucket and the reason for it go into the brief and into the task's ledger line.",
  "- **The session reviews a plan by its header, task list and Self-Review.** The full plan file goes to a unit — `codex_code_review` or `grok_code_review`, with the spec's path and the plan's path, asking for four-part findings — and the session opens the pointers of the findings, not the file. The ledger records the findings and the rulings as for any review.",
  "- **Pay for judgement, not for repetition.** Reviews, clean-context testers and arbitration are what the tokens are for; re-reading, re-running and re-deriving are where they are lost. A planner does not dry-run its plan: the review reads it, and the coder and the tester run it for real.",
];

test('ORCHESTRATION "Evidence with pointers" says what each agent is handed, and its map links it', () => {
  const md = read('docs/ORCHESTRATION.md');
  const handed = section(md, '### What each agent is handed');
  assert.ok(section(md, '## Evidence with pointers').includes(handed), 'the subsection sits inside "Evidence with pointers"');
  const lines = handed.split('\n');
  for (const item of HANDED_DOC) assert.ok(lines.includes(item), `a line of its own: ${item.slice(0, 60)}`);
  const head = md.slice(0, md.indexOf('\n## '));
  assert.match(head, /^\| .+ \| \[What each agent is handed\]\(#what-each-agent-is-handed\) \|$/m, 'the map at the top, before the first section, links it');
});

// ── 1.3.0 P1: the shipped reviewer in the rules ─────────────────────────────

/**
 * The two rules lines 1.3.0 P1 writes (spec "P1 — `omelette-reviewer`", "Where
 * it slots in"), each pinned whole: the "Reviews" line naming the reviewer, the
 * one file it writes and the check after it; and the definitions line, whose
 * fact moves from two definitions to three. The operating model's coder line
 * is pinned beside them: nothing in this package may change it.
 */
const P1_REVIEWS_LINE = "- **A sub-agent review goes to `omelette-reviewer`.** It writes nothing but `.omelette/reports/<name>-review.md`; run `git status --porcelain` after it and reject the review outright if anything but that report changed.";
// 1.3.0 P2: four definitions, the medium coder right after the coder.
const P1_DEFINITIONS_LINE = "- `omelette-fleet rules --agents` installs four definitions — **`omelette-coder`** (Opus, `effort: xhigh`), **`omelette-coder-medium`** (Opus, `effort: medium`), **`omelette-tester`** (Sonnet, `effort: xhigh`, `maxTurns: 80` by default (config)) and **`omelette-reviewer`** (Opus, `effort: xhigh`) — plus the `/omelette-test` skill. Select a definition with `subagent_type: omelette-coder` / `omelette-coder-medium` / `omelette-tester` / `omelette-reviewer`.";
const CODER_LINE = "- **Code changes go to a strong coding sub-agent** (Opus-class, xhigh — the shipped `omelette-coder`), briefed with the approved plan and the constraints. Never to a fleet unit.";

for (const merge of ['session', 'pr']) {
  test(`"Reviews" names the shipped reviewer, its one file and the git status check, right after the plan-review line (${merge})`, () => {
    const lines = section(renderRulesFile('1.2.0', { merge }), '## Reviews').split('\n');
    const plan = lines.indexOf(PLAN_REVIEW);
    assert.notEqual(plan, -1, 'the plan-review line is in "Reviews"');
    assert.equal(lines[plan + 1], P1_REVIEWS_LINE, 'the reviewer line follows it, whole');
  });

  test(`"Spawning sub-agents" says four definitions, each with its model and effort (${merge})`, () => {
    const lines = section(renderRulesFile('1.2.0', { merge }), '## Spawning sub-agents: model and effort').split('\n');
    assert.ok(lines.includes(P1_DEFINITIONS_LINE), 'the definitions line, whole');
    assert.ok(!lines.some((l) => l.includes('installs two definitions') || l.includes('installs three definitions')), 'the old counts are gone');
  });
}

/**
 * The three lines that counted two shipped roles (spec amendment, ledger
 * 2026-09-24): each loses its count and names every role where it named two,
 * its explanatory words untouched. The branch-per-feature line ends with the
 * merge sentence, so it is pinned with each policy's own.
 */
const P1_BRANCH_LINE_HEAD = "- **Branch per feature; main is gated.** Work on a `feat/<name>` branch. The session commits each task on that branch once its review passes; no shipped sub-agent role commits — the coder reports its diff, the tester reports what it ran, the reviewer reports its findings, and the guard hook refuses any of their `git commit`. ";
const P1_NESTING_LINE = "- Sub-agents may nest up to three levels deep, but every shipped definition carries `disallowedTools: Agent`: they cannot spawn anything, so the **orchestrator** spawns the tester, never the coder.";
// 1.3.0 P2: the fourth name, and only that (the session's ruling).
const P1_GUARD_LINE = "Full text with the model catalogs and escalation rules: `docs/ORCHESTRATION.md` in the omelette-fleet package. The git guard — it contains every shipped role — `omelette-coder`, `omelette-coder-medium`, `omelette-tester` and `omelette-reviewer` — and names the one it caught — and the compaction hook are one script: `omelette-fleet rules --hooks` writes it and prints the settings snippet that calls it — omelette-fleet never edits your settings files itself.";

for (const merge of ['session', 'pr']) {
  test(`the three lines that counted two roles name every shipped role, each whole (${merge})`, () => {
    const text = renderRulesFile('1.2.0', { merge });
    assert.ok(section(text, '## Operating model for the session').split('\n').includes(P1_BRANCH_LINE_HEAD + MERGE_SENTENCES[merge]), 'the branch-per-feature line');
    assert.ok(section(text, '## Spawning sub-agents: model and effort').split('\n').includes(P1_NESTING_LINE), 'the nesting line');
    assert.ok(section(text, '## Briefing a unit').split('\n').includes(P1_GUARD_LINE), 'the guard line');
    for (const stale of ['neither shipped sub-agent role', 'either one\'s', 'both shipped definitions', '**both** shipped roles']) {
      assert.ok(!text.includes(stale), `the count of two is gone: ${stale}`);
    }
  });
}

test('the operating model\'s coder line stays byte for byte, and no 1.3.0 line carries a hook-mechanics string', () => {
  assert.ok(section(rules(), '## Operating model for the session').split('\n').includes(CODER_LINE), 'the "Opus-class, xhigh" line is unchanged');
  for (const line of [P1_REVIEWS_LINE, P1_DEFINITIONS_LINE, P1_BRANCH_LINE_HEAD, P1_NESTING_LINE, P1_GUARD_LINE]) {
    for (const mechanism of MECHANICS) assert.ok(!line.includes(mechanism), `${mechanism} stays out of: ${line.slice(0, 50)}`);
  }
});

// ── 1.3.0 P1: the reviewer in the docs ───────────────────────────────────────

/** ORCHESTRATION "Reviews": what the shipped reviewer is and does, and what keeps it read-only — each a whole paragraph line. */
const REVIEWER_DOC = [
  "**The shipped reviewer.** `omelette-fleet rules --agents` writes `omelette-reviewer` — the clean-context second reader on our own model, the Opus review 1.2.0 briefed by hand, now a definition (`model: opus` and `effort: xhigh` by default, tools `Read, Grep, Glob, Bash, Write`, `disallowedTools: Agent, Edit, NotebookEdit`). One spawn is one review of one thing: a plan, a task's diff or a branch. Its brief carries the base and head (or the file) and the spec's path, and, for a re-review only, the earlier findings and the rulings on them. It reads what it reviews, runs the suite when the brief says so, and reports findings only, ranked, each `location · scenario · consequence · how to confirm` with the location as a pointer line `omelette-fleet check` can verify, then one verdict line: `ship`, `do not ship` or `needs-check`. The report goes to `.omelette/reports/<name>-review.md`; the reply is the verdict line and the count. The Routing table's code-review row stays Codex: this adds a reader, it replaces none.",
  "**Read-only by definition and by check, not by enforcement.** Claude Code's tool filtering cannot scope `Write` to one path or make `Bash` read-only, and the guard refuses only the git commands it names. So the definition says the only file the reviewer writes is its report; the guard refuses its `git commit`, `stash`, branch creation and `worktree` by name, as it does the coder's; and the session runs `git status --porcelain` after every review and rejects the review outright if anything but that report changed.",
];
/** ORCHESTRATION "Spawning sub-agents": the reviewer's item in the list of shipped definitions. */
const SPAWN_BULLET = "- **`omelette-reviewer`** — `model: opus`, `effort: xhigh`, `disallowedTools: Agent, Edit, NotebookEdit`, tools `Read, Grep, Glob, Bash, Write`. One review of one thing with a clean context: findings only, ranked, in four parts, then `ship`, `do not ship` or `needs-check`; the one file it writes is its report ([Reviews](#reviews)).";
/** CONFIG "Agent settings": the reviewer's two keys. */
const CONFIG_ROWS = [
  '| `agents.reviewer.model` | one printable line | `"opus"` | The `model:` line of `omelette-reviewer.md` |',
  '| `agents.reviewer.effort` | `low` \\| `medium` \\| `high` \\| `xhigh` \\| `max` | `"xhigh"` | Its `effort:` line — review is judgement, the thing a release pays for |',
];
/** SECURITY "The guard hook": what the guard does, and does not do, for the reviewer. */
const SECURITY_REVIEWER = "The reviewer is contained the same way, and this guard is all the enforcement it gets: Claude Code cannot scope `Write` to one path or make `Bash` read-only, so its read-only is the definition's text — the only file it writes is `.omelette/reports/<name>-review.md` — and the session's `git status --porcelain` after every review, which rejects the review if anything but that report changed.";
/** README's `rules` row: the three definitions `--agents` writes. */
const README_AGENTS = "`--agents` also writes three sub-agent definitions (`omelette-coder`: Opus xhigh; `omelette-tester`: Sonnet xhigh; `omelette-reviewer`: Opus xhigh; all three `disallowedTools: Agent`, the reviewer also `Edit, NotebookEdit`)";

test('ORCHESTRATION "Reviews" describes the shipped reviewer and what keeps it read-only, and the map asks for it', () => {
  const md = read('docs/ORCHESTRATION.md');
  const lines = section(md, '## Reviews').split('\n');
  for (const paragraph of REVIEWER_DOC) assert.ok(lines.includes(paragraph), `a paragraph of its own: ${paragraph.slice(0, 60)}`);
  const head = md.slice(0, md.indexOf('\n## '));
  assert.ok(head.split('\n').includes('| Which sub-agent runs a review, and what keeps it read-only? | [Reviews](#reviews) |'), 'the map at the top asks for it');
});

test('ORCHESTRATION counts four definitions and four guarded roles, and lists the reviewer', () => {
  const md = read('docs/ORCHESTRATION.md');
  assert.ok(md.includes('when the caller is one of the four roles this package ships — `omelette-coder`, `omelette-coder-medium`, `omelette-tester` or `omelette-reviewer` —'), 'Layer 3 names the four guarded roles');
  const spawning = section(md, '## Spawning sub-agents: model and effort');
  const lines = spawning.split('\n');
  assert.ok(lines.includes('`omelette-fleet rules --agents` writes four of these next to the rules file:'));
  assert.ok(lines.includes(SPAWN_BULLET), 'the reviewer item, whole');
  assert.ok(spawning.includes('Select them with `subagent_type: omelette-coder` / `omelette-coder-medium` / `omelette-tester` / `omelette-reviewer`. All four are refreshed'));
  assert.ok(!spawning.includes('writes two of these') && !/\b(both|BOTH) shipped\b/.test(spawning), 'no count of two is left');
});

test('CONFIG "Agent settings" documents agents.reviewer.model and agents.reviewer.effort', () => {
  const md = read('docs/CONFIG.md');
  const lines = section(md, '### Agent settings').split('\n');
  for (const row of CONFIG_ROWS) assert.ok(lines.includes(row), `a key row: ${row.slice(0, 40)}`);
  assert.ok(lines.some((l) => l.includes('the four Claude Code sub-agent definitions `omelette-fleet rules --agents` writes')), 'the intro counts four');
  assert.ok(md.split('\n').includes('| How do I configure the coder, tester and reviewer sub-agents? | [Agent settings](#agent-settings) |'), 'the map row names the reviewer');
  assert.ok(md.includes('    "reviewer": { "model": "opus", "effort": "xhigh" }'), 'the Shape block shows the reviewer entry');
});

test('SECURITY: the PreToolUse row names the four guarded roles and says what the guard does not do for the reviewer', () => {
  const md = read('docs/SECURITY.md');
  const guard = section(md, '## The guard hook');
  assert.ok(guard.includes('When the caller is one of the four sub-agent roles this package ships — `omelette-coder`, `omelette-coder-medium`, `omelette-tester` or `omelette-reviewer` —'));
  assert.ok(guard.includes(SECURITY_REVIEWER), 'the reviewer sentence, whole');
  assert.ok(md.includes('`.claude/agents/omelette-coder.md`, `.claude/agents/omelette-coder-medium.md`, `.claude/agents/omelette-tester.md`, `.claude/agents/omelette-reviewer.md` and `.claude/skills/omelette-test/SKILL.md`'), '"What this package never does" lists every file it writes');
});

test('README counts three sub-agent definitions where it counted two', () => {
  const md = read('README.md');
  assert.ok(md.includes('so you get the operating rules, the three sub-agent definitions, the `/omelette-test` skill'));
  assert.ok(md.includes(README_AGENTS));
  assert.ok(!md.includes('two sub-agent definitions') && !md.includes('both sub-agent definitions'));
});

// ── 1.3.0 P2: the coder line says which coder to brief ───────────────────────

/**
 * The operating model's coder line with the bucket clause (spec P2, "The rule"):
 * the 1.2.0 words untouched, the clause after them. Pinned whole, so a bucket
 * condition dropped from it fails here. `CODER_LINE` (P1) is rules line 9,
 * which P2 leaves byte for byte.
 */
const CODER_1_2_0 = "- A coder gets its task's plan section and pointers, not the spec, whose path covers what the plan left open.";
const CODER_BUCKETS = "- A coder gets its task's plan section and pointers, not the spec, whose path covers what the plan left open. Brief `omelette-coder-medium` when the section prints the exact text, diff, tests and expected numbers (the coder executes), `omelette-coder` otherwise (a new thing with no written shape, debugging with no known cause, a decision the brief explicitly delegates); a brief leaving a required decision open gets `NEEDS_CONTEXT` at any effort; the bucket and its reason go into the brief and the ledger line.";

test('the coder line carries the bucket clause after its 1.2.0 words, whole, under either merge policy — and the "Opus-class, xhigh" line is untouched', () => {
  assert.ok(CODER_BUCKETS.startsWith(`${CODER_1_2_0} `), 'the clause is appended; the 1.2.0 words are its first words');
  for (const merge of ['session', 'pr']) {
    const lines = renderRulesFile('1.2.0', { merge }).split('\n');
    assert.ok(lines.includes(CODER_BUCKETS), `${merge}: the coder line with its bucket clause, whole`);
    assert.equal(lines.filter((l) => l.startsWith(CODER_1_2_0)).length, 1, `${merge}: one coder line, not an old one beside the new`);
    assert.ok(lines.includes(CODER_LINE), `${merge}: "Opus-class, xhigh — the shipped omelette-coder" stays byte for byte`);
  }
});
