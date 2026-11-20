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
import { aggregate, blind, redact, redactionTerms, setFingerprint } from '../scripts/eval-blind.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'scripts', 'eval-blind.mjs');
const WORDS = ['Gemini', 'Grok', 'Codex', 'GPT', 'Argon', 'Flash', 'Sol', 'Astra', 'Mistral', 'Vibe', 'Large 4', 'GLM', 'Hydrogen', 'Neon', 'Carbon', 'Claude', 'Opus'];
const TOOLS = ['gemini_research', 'gemini_deep_research', 'grok_research', 'grok_code_review', 'codex_research', 'codex_code_review', 'mistral_security_review', 'mistral_security_repro'];

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
  for (const grade of ['correct', 'partly', 'wrong', 'no-answer', 'supports', 'real-not-supporting', 'unreachable-or-invented', 'found', 'not', 'plausible', 'fabricated', 'confirmed', 'grades.jsonl']) {
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
  assert.deepEqual(c.runs.map(({ run, found, recall, findings, confirmed, plausible, fabricated, precision }) => ({ run, found, recall, findings, confirmed, plausible, fabricated, precision })), [
    { run: 1, found: 2, recall: 0.5, findings: 4, confirmed: 1, plausible: 0, fabricated: 1, precision: 0.75 },
    { run: 2, found: 3, recall: 0.75, findings: 4, confirmed: 0, plausible: 1, fabricated: 0, precision: 0.75 },
  ]);
  assert.deepEqual(c.mean, {
    found: 2.5, recall: 0.625, findings: 4, confirmed: 0.5, plausible: 0.5, fabricated: 0.5, precision: 0.75,
    recallOnlyFound: null, recallOnlyFindings: null, recallOnlyFabricated: null, controlFindings: null, controlFabricated: null, failed: 0, wallMs: 6000, tokens: 30,
  });
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
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { ...aggregate({ grades: GRADES, mapping: MAPPING, keys: KEYS }), sets: { R: null } });
});

test('--aggregate --merge D2 carries D2\'s arms this date did not run, marked carriedFrom, and names the count in date', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-evals-merge-'));
  const g = join(dir, 'grading', '2026-10-21');
  mkdirSync(g, { recursive: true });
  mkdirSync(join(dir, 'aggregates'), { recursive: true });
  const prev = aggregate({ grades: GRADES, mapping: MAPPING, keys: KEYS });
  const RT = [{ id: 'q1', prompt: 'Invented question one.' }, { id: 'q2', prompt: 'Invented question two.' }, { id: 'q3', prompt: 'Invented question three.' }];
  writeFileSync(join(dir, 'aggregates', '2026-10-16.json'), JSON.stringify({ ...prev, sets: { R: setFingerprint(RT) } }));
  // This date re-ran only the first arm of the earlier round.
  const [rerun] = prev.arms;
  const blinds = Object.fromEntries(Object.entries(MAPPING.blinds).filter(([, e]) => e.suite === rerun.suite && e.arm === rerun.arm));
  writeFileSync(join(g, 'mapping.json'), JSON.stringify({ ...MAPPING, date: '2026-10-21', blinds, failed: [] }));
  writeFileSync(join(g, 'grades.jsonl'), GRADES.filter((l) => blinds[l.blindId]).map((l) => JSON.stringify(l)).join('\n') + '\n');
  for (const [suite, lines] of Object.entries(KEYS)) {
    mkdirSync(join(dir, 'suites', suite), { recursive: true });
    writeFileSync(join(dir, 'suites', suite, 'key.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  writeFileSync(join(dir, 'suites', 'R', 'tasks.jsonl'), RT.map((l) => JSON.stringify(l)).join('\n') + '\n');
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
  for (const k of ['found', 'recall', 'findings', 'confirmed', 'plausible', 'fabricated', 'precision']) assert.equal(failedRun[k], null, k);
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

test('a name left next to an XHigh level in the middle-dot form collapses with it', () => {
  assert.equal(redact('Gemini · XHigh said so.', redactionTerms()), '[model] said so.');
});

test('this round\'s names are masked as whole words — Anthropic, Claude, Opus, Neon, Hydrogen, Carbon — and longer words keep them', () => {
  const out = redact('Anthropic built Claude Opus 5.5; Neon and Hydrogen are Carbon-based. Neonatal opuses stay.', redactionTerms());
  assert.equal(out, '[model] built [model]; [model] and [model] are [model]-based. Neonatal opuses stay.');
});

test('an empty answer is never put to the grader: it is a failed call marked empty, and its run counts it', () => {
  const lines = [
    runLine({ taskIds: ['q1'], answer: 'An invented answer.' }),
    runLine({ taskIds: ['q2'], answer: '   ' }),
    runLine({ taskIds: ['q3'], ok: false, answer: null, error: 'agy produced no output: invented', empty: true }),
    runLine({ taskIds: ['q3'], run: 2, ok: false, answer: null, error: 'invented transport failure', empty: false }),
  ];
  const { blinded, mapping } = blind({ lines, seed: 3, terms: redactionTerms() });
  assert.deepEqual(blinded.map((b) => b.taskIds), [['q1']]);
  assert.deepEqual(mapping.failed.map((f) => [f.taskIds[0], f.run, f.empty]), [['q2', 1, true], ['q3', 1, true], ['q3', 2, false]]);
  const keys = { R: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }], V: [] };
  const grades = [{ blindId: blinded[0].blindId, taskId: 'q1', item: 'answer', grade: 'correct' }];
  const [arm] = aggregate({ grades, mapping: { date: 'd', ...mapping }, keys }).arms;
  assert.deepEqual(arm.runs.map((r) => [r.run, r.failed, r.empty]), [[1, 2, 2], [2, 1, 0]]);
  assert.deepEqual([arm.total.failed, arm.total.empty], [3, 2]);
});

test('blinding takes R and V lines only: P and I lines are checked, not graded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-evals-blind-pi-'));
  const runs = join(dir, 'runs', '2026-11-20');
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, 'R-a.jsonl'), JSON.stringify(runLine({})) + '\n');
  writeFileSync(join(runs, 'P-a.jsonl'), JSON.stringify(runLine({ suite: 'P', taskIds: ['P01'] })) + '\n');
  writeFileSync(join(runs, 'I-a.jsonl'), JSON.stringify(runLine({ suite: 'I', taskIds: ['I01'] })) + '\n');
  const res = spawnSync(process.execPath, [SCRIPT, '--date', '2026-11-20', '--dir', dir, '--seed', '1'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const blinded = readFileSync(join(dir, 'grading', '2026-11-20', 'blinded.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(blinded.map((b) => b.suite), ['R']);
  assert.match(res.stdout, /2 P\/I line\(s\) left to their checks/);
  const only = mkdtempSync(join(tmpdir(), 'omelette-evals-blind-pi-'));
  mkdirSync(join(only, 'runs', '2026-11-20'), { recursive: true });
  writeFileSync(join(only, 'runs', '2026-11-20', 'P-a.jsonl'), JSON.stringify(runLine({ suite: 'P', taskIds: ['P01'] })) + '\n');
  const none = spawnSync(process.execPath, [SCRIPT, '--date', '2026-11-20', '--dir', only, '--seed', '1'], { encoding: 'utf8' });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no R or V run lines/);
});

test('a failed line from before `empty` was recorded is not recorded, never 0: its run and its arm say null', () => {
  const lines = [
    runLine({ taskIds: ['q1'], answer: 'An invented answer.' }),
    runLine({ taskIds: ['q2'], ok: false, answer: null, error: 'invented failure' }),
  ];
  const { blinded, mapping } = blind({ lines, seed: 1, terms: redactionTerms() });
  assert.deepEqual(mapping.failed.map((f) => f.empty), [null]);
  const keys = { R: [{ id: 'q1' }, { id: 'q2' }], V: [] };
  const grades = [{ blindId: blinded[0].blindId, taskId: 'q1', item: 'answer', grade: 'correct' }];
  const [arm] = aggregate({ grades, mapping: { date: 'd', ...mapping }, keys }).arms;
  assert.deepEqual([arm.runs[0].failed, arm.runs[0].empty], [1, null]);
  assert.deepEqual([arm.total.failed, arm.total.empty], [1, null]);
});

// ─── a level left beside a masked name (two arms of the round differ by level only) ───

test('a level after a middle dot collapses as a whole word only: a longer word or a compound keeps its text', () => {
  const terms = redactionTerms();
  assert.equal(redact('Neon · highlights the bug', terms), '[model] · highlights the bug');
  assert.equal(redact('Neon · high-level design', terms), '[model] · high-level design');
  assert.equal(redact('Neon · XHigh found it', terms), '[model] found it');
});

test('a level in brackets or after a middle dot on the next line collapses with the name', () => {
  const terms = redactionTerms();
  assert.equal(redact('Neon\n(XHigh) found it', terms), '[model] found it');
  assert.equal(redact('Neon\r\n· XHigh found it', terms), '[model] found it');
  // A bare word on the next line is a severity label as often as a level: it stays.
  assert.equal(redact('Neon\nHigh: the retry never ends', terms), '[model]\nHigh: the retry never ends');
});

test('a level as its own word right after the name collapses, and an ordinary sentence word stays', () => {
  const terms = redactionTerms();
  assert.equal(redact('Gemini 4 Neon XHigh', terms), '[model]');
  assert.equal(redact('Neon/XHigh', terms), '[model]');
  assert.equal(redact('Neon/high, then', terms), '[model], then');
  assert.equal(redact('Neon, high', terms), '[model]');
  assert.equal(redact('As Gemini 4 Neon High, I checked.', terms), 'As [model], I checked.');
  for (const kept of ['Neon high-level design', 'Neon is high on recall', 'We rated Neon high.', 'Neon, high recall', 'Neon High recall']) {
    assert.equal(redact(kept, terms), kept.replace('Neon', '[model]'), kept);
  }
});

test('R: the net score is correct minus wrong — partly and no answer score 0 — per run and summed over the arm, with the traps counted', () => {
  const agg = aggregate({ grades: GRADES, mapping: MAPPING, keys: KEYS });
  const a = agg.arms.find((x) => x.suite === 'R' && x.arm === A);
  assert.deepEqual(a.runs.map(({ run, net, traps, trapsPassed }) => ({ run, net, traps, trapsPassed })), [
    { run: 1, net: 2, traps: 1, trapsPassed: 1 },
    { run: 2, net: -1, traps: 1, trapsPassed: 0 },
  ]);
  // The fixture's failed call is a line from before `empty` was recorded: not recorded, never 0.
  assert.deepEqual(a.total, { net: 1, correct: 2, partly: 1, wrong: 1, noAnswer: 1, traps: 2, trapsPassed: 1, failed: 1, empty: null });
  const b = agg.arms.find((x) => x.suite === 'R' && x.arm === B);
  assert.deepEqual([b.total.net, b.total.traps, b.total.trapsPassed], [1, 1, 0]);
});

test('the median wall time is over the arm\'s answered calls, not the mean of its run means', () => {
  const mapping = {
    date: 'd', seed: 1, failed: [],
    blinds: { b1: blindOf('R', A, 1, ['q1'], 1000, null), b2: blindOf('R', A, 1, ['q2'], 1000, null), b3: blindOf('R', A, 2, ['q1'], 10000, null) },
  };
  const [arm] = aggregate({ grades: [], mapping, keys: KEYS }).arms;
  assert.equal(arm.wallMsMedian, 1000);
  assert.equal(arm.mean.wallMs, 5500);
  const c = aggregate({ grades: GRADES, mapping: MAPPING, keys: KEYS }).arms.find((x) => x.suite === 'V');
  assert.equal(c.wallMsMedian, 6000, 'an even count: the mean of the two middle calls');
});

test('a run that is one failed call (a task\'s second answer) still counts its trap as asked in the arm\'s total', () => {
  const mapping = {
    date: 'd', seed: 1,
    blinds: { b1: blindOf('R', A, 1, ['q3'], 1000, null) },
    failed: [{ suite: 'R', arm: A, run: 2, taskIds: ['q3'], unit: 'gemini', model: 'Gemini 3.8 Flash (High)', effort: 'high', cli: 'fake 1.0', empty: false }],
  };
  const [arm] = aggregate({ grades: [ans('b1', 'q3', 'correct')], mapping, keys: KEYS }).arms;
  assert.deepEqual([arm.total.traps, arm.total.trapsPassed, arm.total.net, arm.total.failed, arm.total.empty], [2, 1, 1, 1, 0]);
});

test('a question set is its ids and prompts: a changed prompt is another set, a reordered file is not', () => {
  const a = [{ id: 'q1', prompt: 'Invented one.' }, { id: 'q2', prompt: 'Invented two.' }];
  assert.equal(setFingerprint(a), setFingerprint([a[1], a[0]]));
  assert.notEqual(setFingerprint(a), setFingerprint([a[0], { id: 'q2', prompt: 'Invented two!' }]));
  assert.match(setFingerprint(a), /^[0-9a-f]{16}$/);
});

test('--merge leaves out the R arms of another question set, says so, and still carries the V arms', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-evals-sets-'));
  const g = join(dir, 'grading', '2026-11-20');
  mkdirSync(g, { recursive: true });
  mkdirSync(join(dir, 'aggregates'), { recursive: true });
  // Round one's aggregate: written before sets existed.
  writeFileSync(join(dir, 'aggregates', '2026-10-16.json'), JSON.stringify(aggregate({ grades: GRADES, mapping: MAPPING, keys: KEYS })));
  const N = 'gemini:Gemini 4 Neon (High)';
  writeFileSync(join(g, 'mapping.json'), JSON.stringify({ date: '2026-11-20', seed: 1, blinds: { b1: blindOf('R', N, 1, ['q1'], 1000, null) }, failed: [] }));
  writeFileSync(join(g, 'grades.jsonl'), JSON.stringify(ans('b1', 'q1', 'correct')) + '\n');
  for (const [suite, lines] of Object.entries(KEYS)) {
    mkdirSync(join(dir, 'suites', suite), { recursive: true });
    writeFileSync(join(dir, 'suites', suite, 'key.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  const RT = [{ id: 'q1', prompt: 'Invented new question one.' }];
  writeFileSync(join(dir, 'suites', 'R', 'tasks.jsonl'), RT.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const res = spawnSync(process.execPath, [SCRIPT, '--date', '2026-11-20', '--dir', dir, '--aggregate', '--merge', '2026-10-16'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const agg = JSON.parse(readFileSync(join(dir, 'aggregates', '2026-11-20.json'), 'utf8'));
  assert.deepEqual(agg.arms.map((a) => [a.suite, a.arm, a.carriedFrom || null]), [['R', N, null], ['V', C, '2026-10-16']]);
  assert.match(res.stdout, /R: 2 arm\(s\) of 2026-10-16 not carried/);
  assert.equal(agg.sets.R, setFingerprint(RT));
});

// ─── V by task kind: keyed, recall-only, control ─────────────────────────────

const N = 'gemini:Gemini 4 Neon (High)';
const TASKS_V = [{ id: 'V01', kind: 'keyed' }, { id: 'V02', kind: 'keyed' }, { id: 'X01', kind: 'recall' }, { id: 'C01', kind: 'control', of: 'X01' }];
const KEY_V = [{ id: 'K1', task: 'V01' }, { id: 'K2', task: 'V01' }, { id: 'K3', task: 'V02' }, { id: 'K4', task: 'V02' }, { id: 'K5', task: 'V02' }, { id: 'XK1', task: 'X01' }];
const keyOn = (blindId, taskId, keyId, grade) => ({ blindId, taskId, item: 'key', keyId, grade });
const findingOn = (blindId, taskId, grade, extra = {}) => ({ blindId, taskId, item: 'finding', finding: 'invented location', grade, ...extra });
const vMapping = (blinds, failed = []) => ({ date: 'd', seed: 1, failed, blinds: Object.fromEntries(Object.entries(blinds).map(([b, t]) => [b, blindOf('V', N, 1, [t], 1000, null)])) });

test('V by kind: keyed recall and precision, recall-only bugs found, every finding on a control counted', () => {
  const grades = [
    keyOn('b1', 'V01', 'K1', 'found'), keyOn('b1', 'V01', 'K2', 'not'),
    findingOn('b1', 'V01', 'plausible', { verified: true }), findingOn('b1', 'V01', 'fabricated'), findingOn('b1', 'V01', 'plausible'),
    keyOn('b2', 'X01', 'XK1', 'found'), findingOn('b2', 'X01', 'plausible'), findingOn('b2', 'X01', 'fabricated'),
    findingOn('b3', 'C01', 'plausible'), findingOn('b3', 'C01', 'fabricated'), findingOn('b3', 'C01', 'fabricated'),
  ];
  const [arm] = aggregate({ grades, mapping: vMapping({ b1: 'V01', b2: 'X01', b3: 'C01' }), keys: { R: [], V: KEY_V }, tasks: { V: TASKS_V } }).arms;
  const { found, recall, findings, confirmed, plausible, fabricated, precision, recallOnly, control, ungraded } = arm.runs[0];
  assert.deepEqual({ found, recall, findings, confirmed, plausible, fabricated, precision, recallOnly, control, ungraded }, {
    found: 1, recall: 0.5, findings: 4, confirmed: 1, plausible: 1, fabricated: 1, precision: 0.5,
    recallOnly: { tasks: 1, bugs: 1, found: 1, findings: 3, plausible: 1, fabricated: 1 },
    control: { tasks: 1, findings: 3, plausible: 1, fabricated: 2 },
    ungraded: 0,
  });
  assert.equal(arm.keyItems, 2);
  assert.deepEqual(arm.taskIds, ['C01', 'V01', 'X01']);
  assert.equal(arm.mean.controlFindings, 3);
  assert.equal(arm.mean.recallOnlyFound, 1);
});

test('a failed call on a keyed task counts its key items as not found', () => {
  const failed = [{ ...blindOf('V', N, 1, ['V02'], 1000, null), error: 'agy produced no output: invented', empty: true }];
  const grades = [keyOn('b1', 'V01', 'K1', 'found'), keyOn('b1', 'V01', 'K2', 'not')];
  const [arm] = aggregate({ grades, mapping: vMapping({ b1: 'V01' }, failed), keys: { R: [], V: KEY_V }, tasks: { V: TASKS_V } }).arms;
  assert.deepEqual([arm.runs[0].recall, arm.runs[0].failed, arm.runs[0].empty], [0.2, 1, 1]);
});

test('the session cannot confirm a finding on foreign code, a control has no key, and a key item is its own task\'s', () => {
  const mapping = vMapping({ b1: 'V01', b2: 'X01', b3: 'C01' });
  const run = (line) => aggregate({ grades: [line], mapping, keys: { R: [], V: KEY_V }, tasks: { V: TASKS_V } });
  assert.throws(() => run(findingOn('b2', 'X01', 'plausible', { verified: true })), /grades line 1: .*not our own code/);
  assert.throws(() => run(keyOn('b3', 'C01', 'XK1', 'not')), /grades line 1: .*control/);
  assert.throws(() => run(keyOn('b2', 'X01', 'K1', 'found')), /grades line 1: .*not X01's/);
});

test('a V key names its task on every line or none: round one\'s task-less key belongs to the one keyed task', () => {
  const taskless = { R: [], V: [{ id: 'k1' }, { id: 'k2' }] };
  const grades = [keyOn('b1', 'V01', 'k1', 'found'), keyOn('b1', 'V01', 'k2', 'not')];
  const [arm] = aggregate({ grades, mapping: vMapping({ b1: 'V01' }), keys: taskless, tasks: { V: TASKS_V } }).arms;
  assert.equal(arm.keyItems, 2);
  assert.throws(() => aggregate({ grades: [], mapping: vMapping({ b1: 'V01', b2: 'V02' }), keys: taskless, tasks: { V: TASKS_V } }), /names no task/);
  assert.throws(() => aggregate({ grades: [], mapping: vMapping({ b1: 'V01' }), keys: { R: [], V: [{ id: 'k1', task: 'V01' }, { id: 'k2' }] }, tasks: { V: TASKS_V } }), /every line names its task/);
});
