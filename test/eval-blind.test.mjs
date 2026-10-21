// scripts/eval-blind.mjs — blinding, the rubric and the aggregate (plan docs/superpowers/plans/2026-10-16-evals-mvp.md,
// Task 2). Every answer, task and key below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_MODELS } from '../units/codex/models.js';
import { GEMINI_MODELS } from '../units/gemini/models.js';
import { GROK_MODELS } from '../units/grok/models.js';
import { aggregate, blind, redact, redactionTerms } from '../scripts/eval-blind.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'scripts', 'eval-blind.mjs');
const WORDS = ['Gemini', 'Grok', 'Codex', 'GPT', 'Argon', 'Flash', 'Sol', 'Astra'];
const TOOLS = ['gemini_research', 'gemini_deep_research', 'grok_research', 'grok_code_review', 'codex_research', 'codex_code_review'];

/** A name is gone when no letter-bounded occurrence of it is left, in any case. */
const leftover = (text, name) => new RegExp(`(?<!\\p{L})${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?!\\p{L})`, 'iu').test(text);

test('redaction removes every catalog id and label, the family words and the tool names, in any case and inside URLs', () => {
  const catalog = [...GEMINI_MODELS, ...GROK_MODELS, ...CODEX_MODELS];
  const sample = [
    ...catalog.flatMap((m) => [`I am ${m.id}.`, `Signed, ${m.label}.`, `lower: ${m.id.toLowerCase()}`]),
    ...WORDS.flatMap((w) => [w, w.toUpperCase(), w.toLowerCase()]),
    ...TOOLS.map((t) => `called through ${t}`),
    'As Gemini 4 Argon, I checked.',
    'See https://example.invalid/gemini-4-argon/docs and https://example.invalid/openai/codex/issues.',
    'Built on GPT-6.1 Sol at xhigh, then gpt-6.2 for comparison.',
    'Partial: [codex: hard-killed after 600s — treat the answer as partial; raise codex.timeoutS in the fleet config]',
    'A console solution resolves the solid flashing astral crash.',
  ].join('\n');
  const out = redact(sample, redactionTerms());
  for (const m of catalog) {
    assert.ok(!leftover(out, m.id), `id ${m.id} survived`);
    assert.ok(!leftover(out, m.label), `label ${m.label} survived`);
  }
  for (const w of WORDS) assert.ok(!leftover(out, w), `${w} survived`);
  for (const t of TOOLS) assert.ok(!out.toLowerCase().includes(t), `${t} survived`);
  // A name with its version and level is one redaction, not a name-shaped hole with the version left in it.
  assert.ok(out.includes('As [model], I checked.'), out);
  assert.ok(out.includes('https://example.invalid/[model]/docs'), out);
  assert.ok(!/600s/.test(out), 'the partial marker (it names the unit and its timeout) is gone');
  // Words that only contain a name are not names.
  assert.ok(out.includes('A console solution resolves the solid flashing astral crash.'), out);
});

test('a CLI version or a reported model the catalog does not list is redacted too', () => {
  const terms = redactionTerms(['agy 9.9.9', 'Gemini 9 Basalt (High)']);
  const out = redact('Ran on agy 9.9.9 as Gemini 9 Basalt (High).', terms);
  assert.equal(out, 'Ran on [model] as [model].');
});

/** Run lines as eval-run writes them, invented. */
function runLine(over) {
  return {
    suite: 'R', taskIds: ['q1'], arm: 'gemini:Gemini 3.8 Flash (High)', unit: 'gemini', model: 'Gemini 3.8 Flash (High)',
    effort: 'high', run: 1, cli: 'agy 9.9.9', startedAt: '2026-10-16T10:00:00.000Z', wallMs: 1000, ok: true,
    answer: 'Invented answer from Gemini 3.8 Flash (High).', error: null, usage: { input: 1, output: 2 }, resultId: null, ...over,
  };
}

test('blinding is reproducible from its seed, and the order moves with the seed', () => {
  const lines = Array.from({ length: 8 }, (_, i) => runLine({ taskIds: [`q${i}`], answer: `Invented answer ${i}.` }));
  const a = blind({ lines, seed: 7, terms: redactionTerms() });
  const b = blind({ lines, seed: 7, terms: redactionTerms() });
  const c = blind({ lines, seed: 8, terms: redactionTerms() });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.blinded.map((x) => x.taskIds[0]), c.blinded.map((x) => x.taskIds[0]));
  assert.deepEqual(a.blinded.map((x) => x.blindId), c.blinded.map((x) => x.blindId)); // ids say nothing about order
});

test('the CLI blinds a date: blinded.jsonl carries no arm, model, CLI or timing, and the mapping round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-evals-blind-'));
  const runs = join(dir, 'runs', '2026-10-16');
  mkdirSync(runs, { recursive: true });
  const r = [
    runLine({ taskIds: ['q1'], run: 1 }),
    runLine({ taskIds: ['q2'], run: 1, answer: 'Second invented answer; codex_research said so.' }),
    runLine({ taskIds: ['q1'], run: 2, ok: false, answer: null, error: 'Gemini error: invented' }),
  ];
  const v = [runLine({ suite: 'V', taskIds: ['v1'], arm: 'codex:gpt-6.1-sol', unit: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', cli: 'codex-cli 9.9.9', answer: 'Invented finding at line 3, says GPT-6.1 Sol.' })];
  writeFileSync(join(runs, 'R-gemini-gemini-3.8-flash-high.jsonl'), r.map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeFileSync(join(runs, 'V-codex-gpt-6.1-sol.jsonl'), v.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const res = spawnSync(process.execPath, [SCRIPT, '--date', '2026-10-16', '--dir', dir, '--seed', '42'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /seed 42/);
  const g = join(dir, 'grading', '2026-10-16');
  const blinded = readFileSync(join(g, 'blinded.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const mapping = JSON.parse(readFileSync(join(g, 'mapping.json'), 'utf8'));
  assert.equal(mapping.seed, 42);
  assert.equal(blinded.length, 3, 'the ok answers only; a failed call has nothing to grade');
  const originals = [...r, ...v].filter((l) => l.ok);
  const terms = redactionTerms(['agy 9.9.9', 'codex-cli 9.9.9']);
  const seen = new Set();
  for (const b of blinded) {
    assert.deepEqual(Object.keys(b).sort(), ['answer', 'blindId', 'suite', 'taskIds']);
    const m = mapping.blinds[b.blindId];
    const orig = originals.find((l) => l.arm === m.arm && l.run === m.run && l.suite === b.suite && l.taskIds.join() === b.taskIds.join());
    assert.ok(orig, `blind ${b.blindId} maps back to a run line`);
    assert.deepEqual(m.taskIds, orig.taskIds);
    // V is redacted; R is kept whole (its questions are about models).
    assert.equal(b.answer, b.suite === 'V' ? redact(orig.answer, terms) : orig.answer);
    seen.add(orig);
  }
  assert.equal(seen.size, originals.length, 'every answer once');
  assert.deepEqual(mapping.failed.map((f) => [f.arm, f.run, f.taskIds]), [['gemini:Gemini 3.8 Flash (High)', 2, ['q1']]]);
  // The V answers are redacted; R answers stay whole, so only V text is held to the list.
  const text = readFileSync(join(g, 'blinded.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((b) => b.suite === 'V').map((b) => b.answer).join('\n');
  assert.ok(text.length > 0, 'a V answer was blinded');
  for (const s of ['gemini', 'codex', 'gpt', 'agy 9.9.9', '9.9.9', 'Flash', 'Sol']) assert.ok(!text.toLowerCase().includes(s.toLowerCase()), `${s} reached a blinded V answer`);

  const rubric = readFileSync(join(g, 'rubric.md'), 'utf8');
  for (const grade of ['correct', 'partly', 'wrong', 'no-answer', 'supports', 'real-not-supporting', 'unreachable-or-invented', 'found', 'not', 'plausible-new', 'false', 'grades.jsonl']) {
    assert.ok(rubric.includes(`\`${grade}\``), `rubric names ${grade}`);
  }

  // Blinding a date twice would orphan the grades written against the first mapping.
  const again = spawnSync(process.execPath, [SCRIPT, '--date', '2026-10-16', '--dir', dir], { encoding: 'utf8' });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /mapping/);
  assert.deepEqual(JSON.parse(readFileSync(join(g, 'mapping.json'), 'utf8')), mapping);
});

// ─── the aggregate ───────────────────────────────────────────────────────────

const A = 'gemini:Gemini 3.8 Flash (High)';
const B = 'gemini:Gemini 9 Basalt (High)';
const C = 'codex:gpt-6.1-sol';
const blindOf = (suite, arm, run, taskIds, wallMs, usage, extra = {}) => ({
  suite, arm, run, taskIds, wallMs, usage, unit: arm.split(':')[0], model: arm.split(':')[1], effort: 'high', cli: 'fake 1.0', ...extra,
});
const MAPPING = {
  date: '2026-10-16',
  seed: 1,
  blinds: {
    b1: blindOf('R', A, 1, ['q1'], 1000, { input: 100, output: 50 }),
    b2: blindOf('R', A, 1, ['q2'], 3000, { input: 300, output: 50 }),
    b8: blindOf('R', A, 1, ['q3'], 2000, null),
    b3: blindOf('R', A, 2, ['q1'], 2000, null),
    b4: blindOf('R', A, 2, ['q2'], 2000, null),
    b5: blindOf('R', B, 1, ['q1', 'q2', 'q3'], 10000, { input: 1000, output: 500 }),
    b6: blindOf('V', C, 1, ['v1'], 5000, { input: 10, output: 10, cachedInput: 4 }, { effort: 'xhigh' }),
    b7: blindOf('V', C, 2, ['v1'], 7000, { input: 30, output: 10 }, { effort: 'xhigh' }),
  },
  failed: [{ suite: 'R', arm: A, run: 2, taskIds: ['q3'], unit: 'gemini', model: 'Gemini 3.8 Flash (High)', effort: 'high', cli: 'fake 1.0' }],
};
const KEYS = { R: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3', trap: true }], V: [{ id: 'k1' }, { id: 'k2' }, { id: 'k3' }, { id: 'k4' }] };
const ans = (blindId, taskId, grade, extra = {}) => ({ blindId, taskId, item: 'answer', grade, ...extra });
const url = (blindId, taskId, grade) => ({ blindId, taskId, item: 'url', url: 'https://example.invalid/x', grade });
const key = (blindId, keyId, grade, extra = {}) => ({ blindId, taskId: 'v1', item: 'key', keyId, grade, ...extra });
const finding = (blindId, grade, extra = {}) => ({ blindId, taskId: 'v1', item: 'finding', finding: 'invented location', grade, ...extra });
const GRADES = [
  ans('b1', 'q1', 'correct'), url('b1', 'q1', 'supports'),
  ans('b2', 'q2', 'wrong', { overturned: { from: 'wrong', to: 'partly' } }), url('b2', 'q2', 'unreachable-or-invented'), url('b2', 'q2', 'unreachable-or-invented'),
  ans('b8', 'q3', 'correct'),
  ans('b3', 'q1', 'wrong', { uncertain: true }), url('b3', 'q1', 'real-not-supporting'),
  ans('b4', 'q2', 'no-answer'),
  ans('b5', 'q1', 'correct'), ans('b5', 'q2', 'correct'), ans('b5', 'q3', 'wrong'),
  key('b6', 'k1', 'found'), key('b6', 'k2', 'found'), key('b6', 'k3', 'not'), key('b6', 'k4', 'not'),
  finding('b6', 'plausible-new', { verified: true }), finding('b6', 'false'),
  key('b7', 'k1', 'found'), key('b7', 'k2', 'not', { overturned: { from: 'not', to: 'found' } }), key('b7', 'k3', 'found'), key('b7', 'k4', 'not'),
  finding('b7', 'plausible-new'),
];

test('the aggregate\'s numbers on a fixed grades fixture: R counts and the trap, V recall and precision, time and tokens', () => {
  const agg = aggregate({ grades: GRADES, mapping: MAPPING, keys: KEYS });
  const arm = (suite, name) => agg.arms.find((a) => a.suite === suite && a.arm === name);

  const a = arm('R', A);
  assert.equal(a.n, 2);
  assert.equal(a.batch, false);
  assert.deepEqual(a.runs.map(({ run, correct, partly, wrong, noAnswer, inventedUrls, trap, failed }) => ({ run, correct, partly, wrong, noAnswer, inventedUrls, trap, failed })), [
    { run: 1, correct: 2, partly: 1, wrong: 0, noAnswer: 0, inventedUrls: 2, trap: 'passed', failed: 0 },
    { run: 2, correct: 0, partly: 0, wrong: 1, noAnswer: 1, inventedUrls: 0, trap: 'failed', failed: 1 },
  ]);
  assert.deepEqual(a.runs.map((r) => [r.wallMs, r.tokens, r.tokensReported]), [[2000, 250, '2 of 3'], [2000, null, '0 of 2']]);
  assert.deepEqual(a.mean, { correct: 1, partly: 0.5, wrong: 0.5, noAnswer: 0.5, inventedUrls: 1, trapPassed: 0.5, failed: 0.5, wallMs: 2000, tokens: 250 });
  assert.equal(a.overturned, 1);

  const b = arm('R', B);
  assert.equal(b.batch, true);
  assert.deepEqual(b.mean, { correct: 2, partly: 0, wrong: 1, noAnswer: 0, inventedUrls: 0, trapPassed: 0, failed: 0, wallMs: 10000, tokens: 1500 });

  const c = arm('V', C);
  assert.equal(c.keyItems, 4);
  assert.deepEqual(c.runs.map(({ run, found, recall, findings, verifiedNew, unverifiedNew, falseFindings, precision }) => ({ run, found, recall, findings, verifiedNew, unverifiedNew, falseFindings, precision })), [
    { run: 1, found: 2, recall: 0.5, findings: 4, verifiedNew: 1, unverifiedNew: 0, falseFindings: 1, precision: 0.75 },
    { run: 2, found: 3, recall: 0.75, findings: 4, verifiedNew: 0, unverifiedNew: 1, falseFindings: 0, precision: 0.75 },
  ]);
  assert.deepEqual(c.mean, { found: 2.5, recall: 0.625, findings: 4, verifiedNew: 0.5, unverifiedNew: 0.5, falseFindings: 0.5, precision: 0.75, failed: 0, wallMs: 6000, tokens: 30 });
  assert.equal(c.effort, 'xhigh');
  assert.equal(agg.overturned, 2);
  assert.equal(agg.grades, GRADES.length);
  // Numbers and arm names only: no note, URL or finding text reaches the aggregate.
  const text = JSON.stringify(agg);
  assert.ok(!text.includes('example.invalid') && !text.includes('invented location'));
});

test('an overturned grade counts by its final value', () => {
  const mapping = { date: 'd', seed: 1, blinds: { b1: blindOf('R', A, 1, ['q1'], 1, null) }, failed: [] };
  const keys = { R: [{ id: 'q1' }], V: [] };
  const plain = aggregate({ grades: [ans('b1', 'q1', 'wrong')], mapping, keys }).arms[0];
  const over = aggregate({ grades: [ans('b1', 'q1', 'wrong', { overturned: { from: 'wrong', to: 'correct' } })], mapping, keys }).arms[0];
  assert.deepEqual([plain.runs[0].correct, plain.runs[0].wrong, plain.overturned], [0, 1, 0]);
  assert.deepEqual([over.runs[0].correct, over.runs[0].wrong, over.overturned], [1, 0, 1]);
});

test('a grade line the rubric does not allow is refused with its line number', () => {
  const keys = { R: [{ id: 'q1' }], V: [] };
  const mapping = { date: 'd', seed: 1, blinds: { b1: blindOf('R', A, 1, ['q1'], 1, null) }, failed: [] };
  assert.throws(() => aggregate({ grades: [ans('b1', 'q1', 'mostly')], mapping, keys }), /line 1/);
  assert.throws(() => aggregate({ grades: [ans('b9', 'q1', 'correct')], mapping, keys }), /b9/);
  assert.throws(() => aggregate({ grades: [ans('b1', 'q7', 'correct')], mapping, keys }), /q7/);
});

test('--aggregate writes aggregates/<date>.json from grades.jsonl, the mapping and the keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-evals-agg-'));
  const g = join(dir, 'grading', '2026-10-16');
  mkdirSync(g, { recursive: true });
  writeFileSync(join(g, 'mapping.json'), JSON.stringify(MAPPING));
  writeFileSync(join(g, 'grades.jsonl'), GRADES.map((l) => JSON.stringify(l)).join('\n') + '\n');
  for (const [suite, lines] of Object.entries(KEYS)) {
    mkdirSync(join(dir, 'suites', suite), { recursive: true });
    writeFileSync(join(dir, 'suites', suite, 'key.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  const res = spawnSync(process.execPath, [SCRIPT, '--date', '2026-10-16', '--dir', dir, '--aggregate'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const out = join(dir, 'aggregates', '2026-10-16.json');
  assert.ok(existsSync(out));
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), aggregate({ grades: GRADES, mapping: MAPPING, keys: KEYS }));
});

test('--aggregate --merge D2 carries D2\'s arms this date did not run, marked carriedFrom, and names the count in date', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-evals-merge-'));
  const g = join(dir, 'grading', '2026-10-21');
  mkdirSync(g, { recursive: true });
  mkdirSync(join(dir, 'aggregates'), { recursive: true });
  const prev = aggregate({ grades: GRADES, mapping: MAPPING, keys: KEYS });
  writeFileSync(join(dir, 'aggregates', '2026-10-16.json'), JSON.stringify(prev));
  // This date re-ran only the first arm of the earlier round.
  const [rerun] = prev.arms;
  const blinds = Object.fromEntries(Object.entries(MAPPING.blinds).filter(([, e]) => e.suite === rerun.suite && e.arm === rerun.arm));
  writeFileSync(join(g, 'mapping.json'), JSON.stringify({ ...MAPPING, date: '2026-10-21', blinds, failed: [] }));
  writeFileSync(join(g, 'grades.jsonl'), GRADES.filter((l) => blinds[l.blindId]).map((l) => JSON.stringify(l)).join('\n') + '\n');
  for (const [suite, lines] of Object.entries(KEYS)) {
    mkdirSync(join(dir, 'suites', suite), { recursive: true });
    writeFileSync(join(dir, 'suites', suite, 'key.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  const res = spawnSync(process.execPath, [SCRIPT, '--date', '2026-10-21', '--dir', dir, '--aggregate', '--merge', '2026-10-16'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const agg = JSON.parse(readFileSync(join(dir, 'aggregates', '2026-10-21.json'), 'utf8'));
  assert.equal(agg.date, `2026-10-21 (1 arm; ${prev.arms.length - 1} carried from 2026-10-16)`);
  assert.equal(agg.carriedFrom, '2026-10-16');
  assert.equal(agg.arms.length, prev.arms.length);
  const own = agg.arms.filter((a) => !a.carriedFrom);
  assert.deepEqual(own.map((a) => [a.suite, a.arm]), [[rerun.suite, rerun.arm]]);
  assert.deepEqual(agg.arms.filter((a) => a.carriedFrom).map(({ carriedFrom, ...a }) => a), prev.arms.slice(1));
  assert.equal(agg.grades, GRADES.filter((l) => blinds[l.blindId]).length);
  assert.match(res.stdout, /carried from 2026-10-16/);
  // --merge without --aggregate, or with a malformed date, is refused.
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--date', '2026-10-21', '--dir', dir, '--merge', '2026-10-16'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--date', '2026-10-21', '--dir', dir, '--aggregate', '--merge', 'x'], { encoding: 'utf8' }).status, 2);
});

test('a run whose calls all failed has no score: it is counted as failed and left out of the means', () => {
  const mapping = {
    date: 'd', seed: 1,
    blinds: { b1: blindOf('V', C, 1, ['v1'], 1000, null), b2: blindOf('V', C, 2, ['v1'], 1000, null) },
    failed: [{ suite: 'V', arm: C, run: 3, taskIds: ['v1'], unit: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', cli: 'fake 1.0' }],
  };
  const grades = [
    key('b1', 'k1', 'found'), key('b1', 'k2', 'found'), key('b1', 'k3', 'not'), key('b1', 'k4', 'not'),
    key('b2', 'k1', 'found'), key('b2', 'k2', 'not'), key('b2', 'k3', 'not'), key('b2', 'k4', 'not'),
  ];
  const [arm] = aggregate({ grades, mapping, keys: KEYS }).arms;
  assert.deepEqual(arm.runs.map((r) => r.recall), [0.5, 0.25, null]);
  const failedRun = arm.runs[2];
  assert.equal(failedRun.failed, 1);
  for (const k of ['found', 'recall', 'findings', 'verifiedNew', 'unverifiedNew', 'falseFindings', 'precision']) assert.equal(failedRun[k], null, k);
  assert.equal(arm.mean.recall, 0.375);
  assert.equal(arm.failedRuns, 1);
});

test('an R run whose calls all failed has no score either', () => {
  const mapping = {
    date: 'd', seed: 1,
    blinds: { b1: blindOf('R', A, 1, ['q1'], 1000, null) },
    failed: [{ suite: 'R', arm: A, run: 2, taskIds: ['q1', 'q3'], unit: 'gemini', model: 'Gemini 3.8 Flash (High)', effort: 'high', cli: 'fake 1.0' }],
  };
  const [arm] = aggregate({ grades: [ans('b1', 'q1', 'correct')], mapping, keys: KEYS }).arms;
  const failedRun = arm.runs[1];
  for (const k of ['correct', 'partly', 'wrong', 'noAnswer', 'urls', 'inventedUrls', 'trap']) assert.equal(failedRun[k], null, k);
  assert.equal(failedRun.failed, 2);
  assert.equal(arm.mean.correct, 1);
  assert.equal(arm.mean.trapPassed, null);
  assert.equal(arm.failedRuns, 1);
});

test('vendor and tool words are redacted as whole words, in any case', () => {
  const out = redact('OpenAI, ChatGPT, Google, DeepMind, xAI, Antigravity and agy; openai, XAI, AGY. Agyle and googled stay.', redactionTerms());
  assert.equal(out, '[model], [model], [model], [model], [model], [model] and [model]; [model], [model], [model]. Agyle and googled stay.');
});

test('a name and its version collapse across a Unicode space or a dash, never a newline (a numbered list keeps its numbers)', () => {
  const terms = redactionTerms();
  assert.equal(redact('Gemini\n2. next point', terms), '[model]\n2. next point');
  assert.equal(redact('Gemini 4 Argon', terms), '[model]');
  assert.equal(redact('GPT‑6.1', terms), '[model]');
  assert.equal(redact('GPT—6‑1 here', terms), '[model] here');
});
