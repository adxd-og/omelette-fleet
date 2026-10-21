#!/usr/bin/env node
/**
 * omelette-fleet :: scripts/eval-blind.mjs
 * Blinding, the grader's rubric, and the aggregate the charts are drawn from
 * (plan docs/superpowers/plans/2026-10-16-evals-mvp.md, Task 2).
 *
 *   node scripts/eval-blind.mjs --date YYYY-MM-DD [--dir D] [--seed N]
 *   node scripts/eval-blind.mjs --date YYYY-MM-DD --aggregate [--dir D] [--merge YYYY-MM-DD]
 *
 * BLIND reads every run line of the date (`<D>/runs/<date>/*.jsonl`), redacts
 * each answer, shuffles with a seed it prints, and writes into
 * `<D>/grading/<date>/`:
 *   blinded.jsonl  {blindId, suite, taskIds, answer} — what the grader reads;
 *   mapping.json   blind id → arm, run and the call's facts — never the grader's;
 *   rubric.md      how to grade, and the `grades.jsonl` line format.
 * A failed call has no answer to grade: it goes to the mapping's `failed`, and
 * the aggregate counts it. A date is blinded once — a second mapping would
 * orphan the grades written against the first.
 *
 * REDACTION replaces with `[model]` every catalog id and label
 * (`units/*\/models.js`), the family and vendor words below, every unit tool name, and the
 * CLI versions and model ids the date's run lines report — in any case, inside
 * URLs too, but never inside a longer word (`console` keeps its `sol`). A name
 * left next to its version or level collapses with it, so `Gemini 4 Argon`
 * leaves `[model]`, not `[model] 4 [model]`. Partial markers name the unit and
 * its timeout and become `[partial]`. Timings are not carried at all.
 *
 * AGGREGATE joins `grades.jsonl` with the mapping and the keys into
 * `<D>/aggregates/<date>.json`: numbers and arm names, per run and as means.
 * A run whose calls all failed has no score (its score fields are null), is
 * counted in the arm's `failedRuns`, and stays out of every score's mean.
 * A grade the session overturned (`overturned: {from, to}`) counts as `to`.
 * `--merge D2` carries into the aggregate every arm of `aggregates/<D2>.json`
 * that this date did not run (a partial re-run keeps the other arms): each
 * carried arm says `carriedFrom`, the `date` says how many, and `grades` and
 * `overturned` count this date's grades only.
 *
 * This file holds no task text, no key and no answer.
 */
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PARTIAL_MARK_RE } from '../core/partial.mjs';
import codexUnit from '../units/codex/adapter.mjs';
import { CODEX_MODELS } from '../units/codex/models.js';
import geminiUnit from '../units/gemini/adapter.mjs';
import { GEMINI_MODELS } from '../units/gemini/models.js';
import grokUnit from '../units/grok/adapter.mjs';
import { GROK_MODELS } from '../units/grok/models.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_DIR = join(ROOT, '.omelette', 'evals');
const USAGE = 'usage: node scripts/eval-blind.mjs --date YYYY-MM-DD [--dir D] [--seed N] | --date YYYY-MM-DD --aggregate [--dir D] [--merge YYYY-MM-DD]';

/** The family words the plan names, beside the catalogs' own ids and labels. */
export const FAMILY_WORDS = ['Gemini', 'Grok', 'Codex', 'GPT', 'Argon', 'Flash', 'Sol', 'Astra'];
/** The vendors and the vendor tools an answer may name itself by. */
export const VENDOR_WORDS = ['OpenAI', 'ChatGPT', 'Google', 'DeepMind', 'xAI', 'Antigravity', 'agy'];
export const MASK = '[model]';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every string an answer is redacted of, longest first so a whole id wins over
 * the word inside it. `extra`: the CLI versions and reported model ids of the
 * date's run lines.
 */
export function redactionTerms(extra = []) {
  const catalog = [...GEMINI_MODELS, ...GROK_MODELS, ...CODEX_MODELS].flatMap((m) => [m.id, m.label]);
  const tools = [geminiUnit, grokUnit, codexUnit].flatMap((u) => u.tools.map((t) => t.name));
  const seen = new Map();
  for (const t of [...catalog, ...FAMILY_WORDS, ...VENDOR_WORDS, ...tools, ...extra]) {
    const s = String(t ?? '').trim();
    if (s && !seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s);
  }
  return [...seen.values()].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

// A version, a level (in brackets, after a middle dot, or hyphenated as in a
// slug: `gemini-3.8-flash-high`), or another mask, right after a mask: the rest
// of the same name. Any whitespace (a newline and every Unicode space too), a
// hyphen or dash (U+2010–U+2015 among them) and · _ / join them; a full stop
// never does. Inside a version, a dash may stand for the dot (`6‑1`).
const COLLAPSE = /\[model\](?:[ \t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\-\u2010-\u2015·_/]*(?:v?\d+(?:[.\u2010-\u2015]\d+)*|\((?:low|medium|high|xhigh|max|ultra)\)|·\s*(?:low|medium|high)|\[model\])|[-_\u2010-\u2015](?:low|medium|high|xhigh|max|ultra)(?!\p{L}))+/giu;
const PARTIAL_ALL = new RegExp(PARTIAL_MARK_RE.source, 'g');

/** `text` with every term masked; see the header. */
export function redact(text, terms) {
  // A plural is the same name: `GPTs`.
  const names = new RegExp(`(?<!\\p{L})(?:${terms.map((t) => escapeRe(t).replace(/\s+/g, '\\s+')).join('|')})s?(?!\\p{L})`, 'giu');
  return String(text ?? '').replace(PARTIAL_ALL, '[partial]').replace(names, MASK).replace(COLLAPSE, MASK);
}

/** mulberry32: a small seeded generator, so a shuffle can be repeated from its seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The call's facts the aggregate needs, kept in the mapping and never shown to the grader. */
const facts = (l) => ({
  suite: l.suite, arm: l.arm, run: l.run, taskIds: l.taskIds, unit: l.unit, model: l.model, effort: l.effort,
  cli: l.cli, wallMs: l.wallMs, usage: l.usage ?? null,
});

/**
 * Blind run lines: `{blinded, mapping}`. The ok lines are shuffled with `seed`
 * and numbered in their new order; the failed ones go to `mapping.failed`.
 */
export function blind({ lines, seed, terms }) {
  const ok = lines.filter((l) => l.ok);
  const order = ok.map((_, i) => i);
  const next = rng(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const blinded = [];
  const blinds = {};
  order.forEach((idx, i) => {
    const l = ok[idx];
    const blindId = `b${String(i + 1).padStart(3, '0')}`;
    blinded.push({ blindId, suite: l.suite, taskIds: l.taskIds, answer: l.suite === 'V' ? redact(l.answer, terms) : l.answer });
    // R is kept whole: its questions are about models, so masking their names would make the answers ungradable.
    blinds[blindId] = facts(l);
  });
  const failed = lines.filter((l) => !l.ok).map((l) => ({ ...facts(l), error: l.error ?? null }));
  return { blinded, mapping: { seed, blinds, failed } };
}

/** The grader's instructions for one date, from the spec's Grading section. */
export function rubric(date) {
  return `# Grading rubric, ${date}

You grade the answers in \`blinded.jsonl\` against the keys (\`suites/R/key.jsonl\`, \`suites/V/key.jsonl\`). Each answer has a blind id; nothing says which model wrote it, and model names in it read \`[model]\`. Do not guess the author.

Write \`grades.jsonl\` in this directory: one JSON object per line, one line per graded item. Grade every task of every answer, and every key item for every V answer.

## R: research

An answer holds one task, or several (one prompt for all questions): then its numbers follow \`taskIds\`, question 1 being the first id.

Per task, one \`answer\` line, graded:
- \`correct\`: the key's answer, with nothing wrong beside it;
- \`partly\`: part of the key's answer, or the answer with a wrong detail;
- \`wrong\`: an answer the key contradicts;
- \`no-answer\`: declined, or nothing on that question.

Per URL the answer cites for that task, one \`url\` line, graded:
- \`supports\`: real, and it supports what the answer says;
- \`real-not-supporting\`: real, and it does not say that;
- \`unreachable-or-invented\`: does not load, or does not exist.

\`\`\`
{"blindId":"b001","taskId":"<task id>","item":"answer","grade":"correct"}
{"blindId":"b001","taskId":"<task id>","item":"url","url":"https://…","grade":"supports"}
\`\`\`

## V: review

Per key item, one \`key\` line: \`found\` (the answer names that defect: its location and its scenario) or \`not\`.

Per finding the key does not hold, one \`finding\` line naming its location in one line: \`plausible-new\` (it may be real; the session verifies it) or \`false\`.

\`\`\`
{"blindId":"b002","taskId":"<task id>","item":"key","keyId":"<key id>","grade":"found"}
{"blindId":"b002","taskId":"<task id>","item":"finding","finding":"<location, one line>","grade":"plausible-new"}
\`\`\`

## On any line

- \`"uncertain": true\` when you are not sure: the session checks every such grade.
- \`"note": "…"\`, optional, one line.

## Added by the session, not the grader

- \`"overturned": {"from": "<grade>", "to": "<grade>"}\` on a grade the session changed: it counts as \`to\`.
- \`"verified": true\` on a \`plausible-new\` finding the session confirmed: it counts toward precision.
`;
}

const GRADES = {
  R: { answer: ['correct', 'partly', 'wrong', 'no-answer'], url: ['supports', 'real-not-supporting', 'unreachable-or-invented'] },
  V: { key: ['found', 'not'], finding: ['plausible-new', 'false'] },
};

/** A grade line's final value: the session's, when it overturned the grader. */
const finalGrade = (g) => (g.overturned ? g.overturned.to : g.grade);

/** Check every grade line against the rubric and the mapping; throws naming the line. */
function checkGrades(grades, mapping, keyIds) {
  const seen = new Set();
  grades.forEach((g, i) => {
    const at = `grades line ${i + 1}`;
    if (!g || typeof g !== 'object') throw new Error(`${at}: not an object`);
    const b = mapping.blinds[g.blindId];
    if (!b) throw new Error(`${at}: blind id "${g.blindId}" is not in the mapping`);
    if (!b.taskIds.includes(g.taskId)) throw new Error(`${at}: task "${g.taskId}" is not in blind ${g.blindId}`);
    const allowed = GRADES[b.suite] && GRADES[b.suite][g.item];
    if (!allowed) throw new Error(`${at}: item "${g.item}" is not graded in suite ${b.suite}`);
    if (!allowed.includes(g.grade)) throw new Error(`${at}: "${g.grade}" is not a grade for ${g.item} (${allowed.join(', ')})`);
    if (g.overturned !== undefined) {
      const o = g.overturned;
      if (!o || !allowed.includes(o.from) || !allowed.includes(o.to)) throw new Error(`${at}: overturned needs a from and a to among ${allowed.join(', ')}`);
    }
    if (g.item === 'key' && !keyIds.V.has(g.keyId)) throw new Error(`${at}: key item "${g.keyId}" is not in the V key`);
    const one = g.item === 'answer' ? `${g.blindId}/${g.taskId}` : g.item === 'key' ? `${g.blindId}/${g.keyId}` : null;
    if (one) {
      if (seen.has(`${g.item}:${one}`)) throw new Error(`${at}: a second ${g.item} grade for ${one}`);
      seen.add(`${g.item}:${one}`);
    }
  });
}

const mean = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const distinct = (xs) => [...new Set(xs.filter((x) => x !== null && x !== undefined && x !== ''))];
const one = (xs) => distinct(xs).join(' / ') || null;

/** Wall time and tokens of one run's answered calls. */
function costOf(calls) {
  const reported = calls.filter((c) => c.usage && Number.isFinite(c.usage.input) && Number.isFinite(c.usage.output));
  return {
    wallMs: mean(calls.map((c) => c.wallMs)),
    tokens: mean(reported.map((c) => c.usage.input + c.usage.output)),
    tokensReported: `${reported.length} of ${calls.length}`,
  };
}

/** R, one run: the four answer grades, invented URLs, the trap, failed calls. A run with no answered call has no score. */
function rRun({ calls, failed, grades, trapIds }) {
  const failedCount = failed.reduce((n, f) => n + f.taskIds.length, 0);
  if (!calls.length) return { correct: null, partly: null, wrong: null, noAnswer: null, urls: null, inventedUrls: null, ungraded: 0, trap: null, failed: failedCount };
  const r = { correct: 0, partly: 0, wrong: 0, noAnswer: 0, urls: 0, inventedUrls: 0, ungraded: 0 };
  const field = { correct: 'correct', partly: 'partly', wrong: 'wrong', 'no-answer': 'noAnswer' };
  const answerOf = new Map();
  for (const g of grades) {
    if (g.item === 'answer') { r[field[finalGrade(g)]] += 1; answerOf.set(g.taskId, finalGrade(g)); }
    if (g.item === 'url') { r.urls += 1; if (finalGrade(g) === 'unreachable-or-invented') r.inventedUrls += 1; }
  }
  const answered = calls.flatMap((c) => c.taskIds);
  r.ungraded = answered.filter((t) => !answerOf.has(t)).length;
  const covered = [...answered, ...failed.flatMap((f) => f.taskIds)];
  const traps = covered.filter((t) => trapIds.has(t));
  r.trap = traps.length ? (traps.every((t) => answerOf.get(t) === 'correct') ? 'passed' : 'failed') : null;
  r.failed = failedCount;
  return r;
}

/** V, one run: key items found, recall, findings, precision, false findings. A run with no answered call has no score. */
function vRun({ calls, failed, grades, keyCount }) {
  if (!calls.length) {
    return { found: null, recall: null, findings: null, verifiedNew: null, unverifiedNew: null, falseFindings: null, precision: null, ungraded: 0, failed: failed.length };
  }
  const found = new Set(grades.filter((g) => g.item === 'key' && finalGrade(g) === 'found').map((g) => g.keyId));
  const keyLines = new Set(grades.filter((g) => g.item === 'key').map((g) => g.keyId));
  const extra = grades.filter((g) => g.item === 'finding');
  const verifiedNew = extra.filter((g) => finalGrade(g) === 'plausible-new' && g.verified === true).length;
  const unverifiedNew = extra.filter((g) => finalGrade(g) === 'plausible-new' && g.verified !== true).length;
  const falseFindings = extra.filter((g) => finalGrade(g) === 'false').length;
  const findings = found.size + extra.length;
  return {
    found: found.size,
    recall: keyCount ? found.size / keyCount : null,
    findings,
    verifiedNew,
    unverifiedNew,
    falseFindings,
    precision: findings ? (found.size + verifiedNew) / findings : null,
    ungraded: Math.max(0, keyCount - keyLines.size),
    failed: failed.length,
  };
}

/**
 * The aggregate: per suite and arm, every run's numbers and their means.
 * `keys` is `{R: [key lines], V: [key lines]}` — ids and the trap flag are all
 * it reads. Throws on a grade line the rubric does not allow.
 */
export function aggregate({ grades, mapping, keys }) {
  const keyIds = { R: new Set((keys.R || []).map((k) => k.id)), V: new Set((keys.V || []).map((k) => k.id)) };
  checkGrades(grades, mapping, keyIds);
  const trapIds = new Set((keys.R || []).filter((k) => k.trap === true).map((k) => k.id));
  const keyCount = keyIds.V.size;

  const arms = new Map();
  const armOf = (e) => {
    const id = `${e.suite}\u0000${e.arm}`;
    if (!arms.has(id)) arms.set(id, { suite: e.suite, arm: e.arm, entries: [], failed: [], grades: [] });
    return arms.get(id);
  };
  for (const [blindId, e] of Object.entries(mapping.blinds)) armOf(e).entries.push({ blindId, ...e });
  for (const f of mapping.failed || []) armOf(f).failed.push(f);
  for (const g of grades) armOf(mapping.blinds[g.blindId]).grades.push(g);

  const out = [];
  for (const a of arms.values()) {
    const all = [...a.entries, ...a.failed];
    const runNumbers = [...new Set(all.map((e) => e.run))].sort((x, y) => x - y);
    const runs = runNumbers.map((run) => {
      const calls = a.entries.filter((e) => e.run === run);
      const ids = new Set(calls.map((c) => c.blindId));
      const failed = a.failed.filter((f) => f.run === run);
      const runGrades = a.grades.filter((g) => ids.has(g.blindId));
      const scores = a.suite === 'R' ? rRun({ calls, failed, grades: runGrades, trapIds }) : vRun({ calls, failed, grades: runGrades, keyCount });
      return { run, ...scores, ...costOf(calls) };
    });
    const m = (k) => mean(runs.map((r) => r[k]));
    const means = a.suite === 'R'
      ? {
        correct: m('correct'), partly: m('partly'), wrong: m('wrong'), noAnswer: m('noAnswer'), inventedUrls: m('inventedUrls'),
        trapPassed: mean(runs.filter((r) => r.trap !== null).map((r) => (r.trap === 'passed' ? 1 : 0))),
      }
      : {
        found: m('found'), recall: m('recall'), findings: m('findings'), verifiedNew: m('verifiedNew'),
        unverifiedNew: m('unverifiedNew'), falseFindings: m('falseFindings'), precision: m('precision'),
      };
    out.push({
      suite: a.suite,
      arm: a.arm,
      unit: one(all.map((e) => e.unit)),
      model: one(all.map((e) => e.model)),
      effort: one(all.map((e) => e.effort)),
      cli: distinct(all.map((e) => e.cli)),
      batch: all.some((e) => (e.taskIds || []).length > 1),
      ...(a.suite === 'R' ? { tasks: keyIds.R.size } : { keyItems: keyCount }),
      n: runs.length,
      failedRuns: runs.filter((r) => !a.entries.some((e) => e.run === r.run)).length,
      runs,
      mean: { ...means, failed: m('failed'), wallMs: m('wallMs'), tokens: m('tokens') },
      overturned: a.grades.filter((g) => g.overturned).length,
    });
  }
  out.sort((x, y) => x.suite.localeCompare(y.suite) || x.arm.localeCompare(y.arm));
  return { date: mapping.date ?? null, arms: out, grades: grades.length, overturned: grades.filter((g) => g.overturned).length };
}

const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
  try { return JSON.parse(l); } catch (e) { throw new Error(`${path}:${i + 1}: not JSON (${e.message})`); }
});
const writePrivate = (path, text) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
};

function cmdBlind({ dir, date, seed, out }) {
  const runsDir = join(dir, 'runs', date);
  const files = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith('.jsonl')).sort() : [];
  if (!files.length) throw new Error(`no run lines at ${runsDir}`);
  const g = join(dir, 'grading', date);
  if (existsSync(join(g, 'mapping.json'))) throw new Error(`${join(g, 'mapping.json')} exists: this date is blinded, and a new mapping would orphan its grades`);
  const lines = files.flatMap((f) => readJsonl(join(runsDir, f)));
  const extra = [
    ...lines.map((l) => l.cli).filter((c) => typeof c === 'string' && !c.startsWith('unknown')),
    ...lines.map((l) => l.model).filter((m) => typeof m === 'string' && !m.startsWith('(')),
  ];
  const { blinded, mapping } = blind({ lines, seed, terms: redactionTerms(extra) });
  writePrivate(join(g, 'blinded.jsonl'), blinded.map((b) => JSON.stringify(b)).join('\n') + (blinded.length ? '\n' : ''));
  writePrivate(join(g, 'mapping.json'), JSON.stringify({ date, ...mapping }, null, 2) + '\n');
  writePrivate(join(g, 'rubric.md'), rubric(date));
  out(`seed ${seed}`);
  out(`${blinded.length} answer(s) blinded, ${mapping.failed.length} failed call(s) kept for the aggregate → ${g}`);
  out('give the grader blinded.jsonl, rubric.md and the keys — never mapping.json');
}

function cmdAggregate({ dir, date, merge, out }) {
  const g = join(dir, 'grading', date);
  for (const f of ['mapping.json', 'grades.jsonl']) if (!existsSync(join(g, f))) throw new Error(`no ${f} at ${g}`);
  const mapping = JSON.parse(readFileSync(join(g, 'mapping.json'), 'utf8'));
  const grades = readJsonl(join(g, 'grades.jsonl'));
  const suites = new Set([...Object.values(mapping.blinds), ...(mapping.failed || [])].map((e) => e.suite));
  const keys = {};
  for (const s of ['R', 'V']) {
    const p = join(dir, 'suites', s, 'key.jsonl');
    if (suites.has(s) && !existsSync(p)) throw new Error(`no key at ${p}`);
    keys[s] = existsSync(p) ? readJsonl(p) : [];
  }
  const agg = aggregate({ grades, mapping, keys });
  if (merge) {
    const prevPath = join(dir, 'aggregates', `${merge}.json`);
    if (!existsSync(prevPath)) throw new Error(`no aggregate to merge at ${prevPath}`);
    const ran = new Set(agg.arms.map((a) => `${a.suite}\u0000${a.arm}`));
    const carried = JSON.parse(readFileSync(prevPath, 'utf8')).arms.filter((a) => !ran.has(`${a.suite}\u0000${a.arm}`)).map((a) => ({ ...a, carriedFrom: merge }));
    agg.arms = [...agg.arms, ...carried].sort((x, y) => x.suite.localeCompare(y.suite) || x.arm.localeCompare(y.arm));
    agg.date = `${date} (${ran.size} arm${ran.size === 1 ? '' : 's'}; ${carried.length} carried from ${merge})`;
    agg.carriedFrom = merge;
  }
  const path = join(dir, 'aggregates', `${date}.json`);
  writePrivate(path, JSON.stringify(agg, null, 2) + '\n');
  for (const a of agg.arms) {
    const ungraded = a.runs.reduce((n, r) => n + r.ungraded, 0);
    out(`${a.suite} ${a.arm}: ${a.n} run(s)${ungraded ? `, ${ungraded} item(s) ungraded` : ''}${a.carriedFrom ? `, carried from ${a.carriedFrom}` : ''}`);
  }
  out(`${agg.grades} grade(s), ${agg.overturned} overturned → ${path}`);
}

export function main(argv = process.argv.slice(2), { out = (l) => console.log(l), err = (l) => console.error(l) } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { date: { type: 'string' }, dir: { type: 'string' }, seed: { type: 'string' }, aggregate: { type: 'boolean' }, merge: { type: 'string' } },
      strict: true, allowPositionals: false,
    }));
  } catch (e) { err(`eval-blind: ${e.message}\n${USAGE}`); return 2; }
  const errors = [];
  if (!/^\d{4}-\d\d-\d\d$/.test(values.date || '')) errors.push('--date YYYY-MM-DD is required');
  const seed = values.seed === undefined ? randomInt(0, 2 ** 31 - 1) : Number(values.seed);
  if (!Number.isSafeInteger(seed) || seed < 0) errors.push('--seed must be a whole number, 0 or more');
  if (values.aggregate && values.seed !== undefined) errors.push('--seed is for blinding, not --aggregate');
  if (values.merge !== undefined && (!values.aggregate || !/^\d{4}-\d\d-\d\d$/.test(values.merge))) errors.push('--merge YYYY-MM-DD goes with --aggregate');
  if (errors.length) { for (const e of errors) err(`eval-blind: ${e}`); err(USAGE); return 2; }
  const dir = resolve(values.dir || DEFAULT_DIR);
  try {
    if (values.aggregate) cmdAggregate({ dir, date: values.date, merge: values.merge, out });
    else cmdBlind({ dir, date: values.date, seed, out });
  } catch (e) { err(`eval-blind: ${(e && e.message) || e}`); return 1; }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = main();
}
