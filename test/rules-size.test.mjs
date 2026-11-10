// 1.2.0 P1 (spec docs/superpowers/specs/2026-09-20-1.2.0-context-design.md,
// "P1 — the rules file as a map"): the rules file keeps every rule byte for byte
// and loses only the prose that explained how the handoff hooks work, which now
// lives in CONFIG "The handoff hooks". These tests pin what left the rules; the
// half on where it went (CONFIG's prose) was removed with the documentation tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MERGE_SENTENCES, renderRulesFile } from '../core/rules.mjs';

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
const MECHANICS = ['40 lines', '4 KB', '12 KB', 'PreCompact', 'SessionStart'];

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

/** The ledger obligations, each by its full sentence (1.7.3 rewrote three and added two; 1.8.0 Task 10 pins the handoff line, rewritten with its six fields). */
const DUTIES = [
  "**Keep a ledger from the first step of a plan**, one line per event: `omelette-fleet ledger open <plan>` writes `<project>/.omelette/ledger-<plan>.md` headed `branch: <the current branch>` (add `.omelette/` to `.gitignore`). A ledger is open while its branch exists and closed once the branch is deleted; `branch: main` (or `master`, `trunk`) never closes.",
  "**Mark a binding ruling when you write it:** `Ruling(binding): <what> — <why> — <cost if wrong>` for a decision that outlives its plan, constrains later work and names the cost of being wrong; one line of about 200 characters, with a pointer (`path:line` · `fragment`, before the marker or at the end) where one exists. Plain `Ruling:` stays in its ledger.",
  "**Before a compaction** — announced or suspected — **and at every natural pause, append a handoff block**, `## Handoff (<date> — <title>)`, its six fields in this order, each a line that opens with its label in bold: `State` (branch, HEAD, tree, what is done) · `Open findings` (unruled, by pointer) · `Agents in flight` (their ids and what each holds) · `Gotchas` (what will bite the next reader, three lines at most) · `Tried` (the `tried:` lines still worth knowing) · `Next action` (one sentence, then the step after it).",
  "**After a compaction or a `/clear`, read in order before doing anything else:** the open ledger's last handoff, the decisions register, the backlog's map — the hook prints all three. At a goal's boundary — a release out, a new plan next — write the handoff, delete the merged branch, and suggest `/clear` to the operator.",
  "**A plan closes when its branch is merged and deleted.** `omelette-fleet ledger sweep` does the rest, and the hook runs it at every session start: the binding rulings go to the register (`.omelette/decisions.md`, or the file its `register:` line names), the ledger is marked closed and moves to `.omelette/archive/`. A register line that stops binding gets `superseded by …` appended, never deleted.",
  "The hooks reach only this repository's `.omelette/` and miss some compactions: the handoff blocks are yours to write; the hook is a net, not a replacement.",
];

// 1.3.0 P1: 13 100 -> 13 510 — the measured render with the reviewer's rules
// lines and the three count-free lines (13 413 characters under `session`,
// 13 381 under `pr`) plus about a hundred characters of headroom. The number
// follows the content; the lines themselves are pinned whole below.
// 1.3.0 P2: 13 510 -> 13 620 — the definitions line and the guard sentence
// name the medium coder (+104: 13 517 / 13 485), plus headroom.
// 1.3.0 P2: 13 620 -> 14 030 — the coder line's bucket clause (+405: 13 922 /
// 13 890), plus headroom; the release's review fixes lengthened the Reviews
// line to 13 987 / 13 955, still under it.
// 1.6.1 Task 2: 14 030 -> 14 590 — the tester flow's second-pass step with
// its measured cold-cache clause and the fallback for a tester that cannot be
// continued, the tester at high and the definitions line's exact ids (+820:
// 13 672 / 13 640 -> 14 492 / 14 460), plus headroom.
// 1.7.1: 14 590 -> 14 700 — the tie-breaker row (+33) and the /clear duty at a
// goal's boundary (operator, 2026-10-16; +82 net after the hooks line was
// tightened; the review fixes' tester line +36): 14 643 / 14 611, plus headroom.
// 1.7.3: 14 700 -> 15 750 — the ledger lifecycle: `ledger open`, the binding mark, the read order after a /clear, the close by sweep (+1 004: 15 647 / 15 615), plus headroom.
// docs-2c p21: 15 750 -> 16 400 — the superpowers paragraph in the operating model: this file wins, five conflicts resolved (+518: 16 188 / 16 156), plus headroom.
// 1.8.0: 16 400 -> 18 850 — the review brief (the plan header, the touched record, BASE and base..HEAD, no pre-judging, what a coder fixes, the yield split), the handoff's six fields, tried:, the gate's HH:MM, the curated files and the guard's two deliveries (+2 512: 18 700 / 18 668), plus headroom.
// 1.9.0: 18 850 -> 19 403 — the Mistral routing row and its "never a sole source" bullet (+410: 19 253 / 19 221), plus headroom.
// 1.10.0: 19 403 -> 20 402 — the hard coders: the coder line's two Fable routes, the tester flow's third round to hard then one to xhard, then the operator, one fix round on each Fable rung, the same round in the superpowers paragraph, six definitions with claude-fable-5-2, six guarded names (+999: 20 252 / 20 220), plus headroom.
test('the rendered rules file is at most 20 402 characters under either merge policy', () => {
  for (const merge of ['session', 'pr']) {
    const text = renderRulesFile('1.2.0', { merge });
    assert.ok(text.length <= 20402, `${merge}: ${text.length} characters`);
  }
});

test('the rules keep every heading and the two evidence bullets byte for byte', () => {
  const lines = rules().split('\n');
  for (const h of HEADINGS) assert.ok(lines.includes(h), `heading kept: ${h}`);
  assert.ok(lines.includes(EVIDENCE), 'the evidence bullet is unchanged');
});

test('"Ledger and handoff" states the six hook obligations in full, one line each, and points at CONFIG for the rest', () => {
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
 * substring pin would stay green. They follow the evidence bullet (1.5.0 P2:
 * the scout-map bullet they followed left the rules, and the planner line with it).
 */
const HANDED = [
  "- A planner gets its spec section and the pointers the session hands it, and the plan header lists what it read.",
  "- A coder gets its task's plan section and pointers, not the spec, whose path covers what the plan left open. Brief `omelette-coder-medium` when the section prints the exact text, diff, tests and expected numbers (the coder executes), `omelette-coder` otherwise (a new thing with no written shape, debugging with no known cause, a decision the brief explicitly delegates), `omelette-coder-hard` (Fable-class, the session's own quota) by name only, one task at a time: the plan's `hard` bucket (refusal or parser logic, a sandbox profile, concurrency, a cause two attempts missed) or the third fix round, fresh, after two failed on the same finding; `omelette-coder-xhard` only for the one round after a `hard` fix round failed on the same finding, or on the operator's word; a Fable coder gets one fix round; a brief leaving a required decision open gets `NEEDS_CONTEXT` at any effort; the bucket and its reason go into the brief and the ledger line.",
  "- Pay for judgement, not for repetition: planners do not dry-run plans.",
];

test('the operating model says what a planner and a coder are handed, and what the session pays for, right after the evidence bullet', () => {
  const lines = section(rules(), '## Operating model for the session').split('\n');
  const evidence = lines.indexOf(EVIDENCE);
  assert.notEqual(evidence, -1, 'the evidence bullet is in the operating model');
  assert.deepEqual(lines.slice(evidence + 1, evidence + 1 + HANDED.length), HANDED, 'the three lines follow the evidence bullet');
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

// ── 1.3.0 P1: the shipped reviewer in the rules ─────────────────────────────

/**
 * The two rules lines 1.3.0 P1 writes (spec "P1 — `omelette-reviewer`", "Where
 * it slots in"), each pinned whole: the "Reviews" line naming the reviewer, the
 * one file it writes and the check after it; and the definitions line, whose
 * fact moves from two definitions to three. The operating model's coder line
 * is pinned beside them: nothing in this package may change it.
 */
const P1_REVIEWS_LINE = "- **A sub-agent review goes to `omelette-reviewer`.** It writes nothing but `.omelette/reports/<name>-review.md`; run `git status --porcelain` and compare `git rev-parse HEAD` and `git symbolic-ref -q HEAD` after it, and reject the review outright if anything but that report changed.";
// 1.3.0 P2: four definitions, the medium coder right after the coder.
// Re-pinned in 1.6.1 Task 2: the tester at high, the models named by generation
// and pinned by exact id. 1.10.0: six, the two hard coders on Fable 5.2.
const P1_DEFINITIONS_LINE = "- `omelette-fleet rules --agents` installs six definitions — **`omelette-coder`** (Opus 5.5, `effort: xhigh`), **`omelette-coder-medium`** (Opus 5.5, `effort: medium`), **`omelette-coder-hard`** (Fable 5.2, `effort: high`), **`omelette-coder-xhard`** (Fable 5.2, `effort: xhigh`), **`omelette-tester`** (Sonnet 5.5, `effort: high`, `maxTurns: 80` by default (config)) and **`omelette-reviewer`** (Opus 5.5, `effort: xhigh`), each model pinned by exact id (`claude-opus-5-5`, `claude-fable-5-2`, `claude-sonnet-5-5`) — plus the `/omelette-test` skill. Select a definition with `subagent_type: omelette-coder` / `omelette-coder-medium` / `omelette-coder-hard` / `omelette-coder-xhard` / `omelette-tester` / `omelette-reviewer`.";
const CODER_LINE = "- **Code changes go to a strong coding sub-agent** (Opus-class, xhigh — the shipped `omelette-coder`), briefed with the approved plan and the constraints. Never to a fleet unit.";

for (const merge of ['session', 'pr']) {
  test(`"Reviews" names the shipped reviewer, its one file and the git status check, right after the plan-review line (${merge})`, () => {
    const lines = section(renderRulesFile('1.2.0', { merge }), '## Reviews').split('\n');
    const plan = lines.indexOf(PLAN_REVIEW);
    assert.notEqual(plan, -1, 'the plan-review line is in "Reviews"');
    assert.equal(lines[plan + 1], P1_REVIEWS_LINE, 'the reviewer line follows it, whole');
  });

  test(`"Spawning sub-agents" says six definitions, each with its model and effort (${merge})`, () => {
    const lines = section(renderRulesFile('1.2.0', { merge }), '## Spawning sub-agents: model and effort').split('\n');
    assert.ok(lines.includes(P1_DEFINITIONS_LINE), 'the definitions line, whole');
    assert.ok(!lines.some((l) => l.includes('installs two definitions') || l.includes('installs three definitions') || l.includes('installs four definitions')), 'the old counts are gone');
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
// 1.3.0 P2: the fourth name, and only that (the session's ruling). 1.10.0: the fifth and sixth.
const P1_GUARD_LINE = "Full text with the model catalogs and escalation rules: `docs/ORCHESTRATION.md` in the omelette-fleet package. The git guard and the compaction hook are one script: `omelette-fleet rules --hooks` writes it and prints the settings snippet that calls it, and omelette-fleet never edits your settings files itself. The guard covers `omelette-coder`, `omelette-coder-medium`, `omelette-coder-hard`, `omelette-coder-xhard`, `omelette-tester` and `omelette-reviewer` and names the one it caught.";

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

// ── 1.3.0 P2: the coder line says which coder to brief ───────────────────────

/**
 * The operating model's coder line with the bucket clause (spec P2, "The rule"):
 * the 1.2.0 words untouched, the clause after them. Pinned whole, so a bucket
 * condition dropped from it fails here. `CODER_LINE` (P1) is rules line 9,
 * which P2 leaves byte for byte.
 */
const CODER_1_2_0 = "- A coder gets its task's plan section and pointers, not the spec, whose path covers what the plan left open.";
const CODER_BUCKETS = "- A coder gets its task's plan section and pointers, not the spec, whose path covers what the plan left open. Brief `omelette-coder-medium` when the section prints the exact text, diff, tests and expected numbers (the coder executes), `omelette-coder` otherwise (a new thing with no written shape, debugging with no known cause, a decision the brief explicitly delegates), `omelette-coder-hard` (Fable-class, the session's own quota) by name only, one task at a time: the plan's `hard` bucket (refusal or parser logic, a sandbox profile, concurrency, a cause two attempts missed) or the third fix round, fresh, after two failed on the same finding; `omelette-coder-xhard` only for the one round after a `hard` fix round failed on the same finding, or on the operator's word; a Fable coder gets one fix round; a brief leaving a required decision open gets `NEEDS_CONTEXT` at any effort; the bucket and its reason go into the brief and the ledger line.";

test('the coder line carries the bucket clause after its 1.2.0 words, whole, under either merge policy — and the "Opus-class, xhigh" line is untouched', () => {
  assert.ok(CODER_BUCKETS.startsWith(`${CODER_1_2_0} `), 'the clause is appended; the 1.2.0 words are its first words');
  for (const merge of ['session', 'pr']) {
    const lines = renderRulesFile('1.2.0', { merge }).split('\n');
    assert.ok(lines.includes(CODER_BUCKETS), `${merge}: the coder line with its bucket clause, whole`);
    assert.equal(lines.filter((l) => l.startsWith(CODER_1_2_0)).length, 1, `${merge}: one coder line, not an old one beside the new`);
    assert.ok(lines.includes(CODER_LINE), `${merge}: "Opus-class, xhigh — the shipped omelette-coder" stays byte for byte`);
  }
});

// ── 1.8.0 Task 10: the review brief, the handoff's fields, tried:, curated files, the touched record ──

/**
 * The lines 1.8.0 writes into the rules (spec "The handoff", "The review brief",
 * "Rules and docs"), by the section each belongs to, each pinned whole: the
 * `tried:` vocabulary and the review-yield split are the spec's exact words. The
 * handoff line with its six fields is the sixth of `DUTIES` above.
 */
const LINES_1_8_0 = {
  '## Operating model for the session': [
    "- A plan's header carries `Global constraints` (the spec's values, verbatim) and `Review focus` (the input classes no task's tests cover, each pointing at the task that should), and each task lists `Consumes` / `Produces` (the names it reads and the ones it defines).",
  ],
  '## Ledger and handoff': [
    "- **Write a dead end as a `tried:` line** when an approach is abandoned or confirmed — `- <date> tried: <approach> — failed | succeeded — <why, one clause>` — so a session after a compaction does not walk the same path; it stays in its ledger.",
    "- **Close a plan with its review yield.** One line, `review yield: <findings> found / <accepted> accepted / <rejected> rejected (wrong <n> / intentional <n> / didn't matter <n>) — <the two or three that mattered>`. It is the cheap measure of what the reviews were worth; keep it honest.",
    "- **Under the compaction gate** (the mod's `handoffGate`, off by default), a handoff heading carries its time, `## Handoff (<date> HH:MM — <title>)`, so the gate can tell a block of the last 30 minutes from an older one.",
    "- **The curated files are appended to, never rewritten:** `.omelette/ledger-*.md`, `.omelette/backlog.md`, `.omelette/decisions.md` and the file its `register:` line names — the guard refuses a Bash write that truncates one and a Write that is not an append, for the session and every role; use Edit for a change in place, and move one first to replace it on purpose.",
  ],
  '## Reviews': [
    "- **When a coder or tester reports, open `.omelette/reports/touched-<role>-<id>.md`** — the files its loop wrote, recorded by the guard from its transcript when it stops — and compare it with the report's `## DIFF` by eye.",
    "- **Write BASE in the dispatch's ledger line before a coder starts** (the commit it builds on), and give a re-review the diff `base..HEAD`, never `HEAD~1`: a fix round can span several commits.",
    "- **A review brief never pre-judges:** no \"do not flag X\", no \"nothing above minor\" — the reviewer finds, the session rules.",
    "- **A coder fixes `important` + `introduced` findings only:** a `nit` or a `pre-existing` one goes to the ledger as one line and to the release's whole-branch review, and a release's final review gets one fix dispatch for all its findings, not one per finding.",
  ],
  '## Briefing a unit': [
    "The guard has two deliveries, the settings hook and the `omelette-fleet` mod: the mod answers first, a stale installed mod carries no guard, and `omelette-fleet doctor`'s guard line says which one is wired.",
  ],
};

for (const merge of ['session', 'pr']) {
  test(`1.8.0: each new rules line is present once, whole, in its section (${merge})`, () => {
    const text = renderRulesFile('1.2.0', { merge });
    const all = text.split('\n');
    for (const [heading, lines] of Object.entries(LINES_1_8_0)) {
      const own = section(text, heading).split('\n');
      for (const line of lines) {
        assert.equal(all.filter((l) => l === line).length, 1, `once in the file: ${line.slice(0, 70)}`);
        assert.ok(own.includes(line), `in ${heading}: ${line.slice(0, 70)}`);
      }
    }
    assert.ok(!text.includes('where the work stands, open findings, agents in flight, next action'), 'the four-item handoff is gone');
    for (const line of Object.values(LINES_1_8_0).flat()) {
      for (const mechanism of MECHANICS) assert.ok(!line.includes(mechanism), `${mechanism} stays out of: ${line.slice(0, 50)}`);
    }
  });
}

// ── 1.10.0: the hard coders' route in the tester flow ───────────────────────

/** Tester flow step 6 with the two Fable rungs (spec 2026-11-10, "2. Routing", row 3), pinned whole. */
const STEP_6_1_10_0 = "6. The ruling, with the findings, goes back to the coder (continue the same sub-agent where the harness supports resuming one, so its context is kept), **at most 2–3 rounds**, then escalate to the operator. After a review past five minutes the coder's cache is gone: brief a fresh coder (task, diff, findings) — a 30–50 k write, not a 310 k rewrite. After two rounds failed on the same finding the third may go to a fresh `omelette-coder-hard`; if the tester's or reviewer's finding still stands after it, one more to a fresh `omelette-coder-xhard`, then the operator. A Fable coder gets one fix round, then the next rung — also on a task it built.";

test('1.10.0: the tester flow sends the third round to a fresh hard coder, then one more to the extra-hard one, then the operator, under either merge policy', () => {
  for (const merge of ['session', 'pr']) {
    const flow = section(renderRulesFile('1.2.0', { merge }), '## Tester flow').split('\n');
    assert.ok(flow.includes(STEP_6_1_10_0), `${merge}: step 6, whole`);
    assert.ok(renderRulesFile('1.2.0', { merge }).includes('fix rounds stop at 2–3 (one more on `omelette-coder-xhard`) and go to the operator'), `${merge}: the superpowers paragraph names the same extra round`);
  }
});
