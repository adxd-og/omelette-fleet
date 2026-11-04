// Independent coverage for 1.2.0 P2 Task 3: the four one-line rules of the
// operating model (what each agent is handed) exist in the rendered rules file
// under either merge policy. The tests on ORCHESTRATION's fuller wording of them
// were removed with the documentation tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRulesFile } from '../core/rules.mjs';

/** The four one-line rules, as rules/omelette-fleet.md renders them. */
const CORRESPONDENCE = [
  {
    rulesLine: "- A planner gets its spec section and the pointers the session hands it, and the plan header lists what it read.",
  },
  {
    rulesLine: "- A coder gets its task's plan section and pointers, not the spec, whose path covers what the plan left open. Brief `omelette-coder-medium` when the section prints the exact text, diff, tests and expected numbers (the coder executes), `omelette-coder` otherwise (a new thing with no written shape, debugging with no known cause, a decision the brief explicitly delegates); a brief leaving a required decision open gets `NEEDS_CONTEXT` at any effort; the bucket and its reason go into the brief and the ledger line.",
  },
  {
    rulesLine: "- Review a plan by header, task list and Self-Review; a unit gets the full file (spec, plan, four-part findings); open the findings' pointers, not the file.",
  },
  {
    rulesLine: "- Pay for judgement, not for repetition: planners do not dry-run plans.",
  },
];

for (const merge of ['session', 'pr']) {
  test(`the four rules-file lines exist in the rendered file under the "${merge}" merge policy`, () => {
    const text = renderRulesFile('1.2.0', { merge });
    const lines = text.split('\n');
    for (const { rulesLine } of CORRESPONDENCE) {
      assert.ok(lines.includes(rulesLine), `rules line present: ${rulesLine.slice(0, 60)}`);
    }
  });
}
