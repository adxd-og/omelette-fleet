// The evals leak check (plan docs/superpowers/plans/2026-10-16-evals-mvp.md, Task 3): only charts are
// published, so no line of a private prompt, answer or key defect may appear in anything under evals/ or in
// scripts/eval-*. The suites live in `.omelette/evals` (ignored by git) — or wherever OMELETTE_EVALS_DIR
// points — and where there are none, as in CI, the check skips and says why.
//
// A hit is reported by file and by suite, line and field — never by quoting the private text it found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PRIVATE = process.env.OMELETTE_EVALS_DIR ? resolve(process.env.OMELETTE_EVALS_DIR) : join(ROOT, '.omelette', 'evals');
const MIN = 24;

function suiteFiles() {
  const dir = join(PRIVATE, 'suites');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((s) => ['tasks.jsonl', 'key.jsonl'].map((f) => join(dir, s, f)))
    .filter((p) => existsSync(p));
}

/** Every string at least MIN characters long, with where it came from: whole, and each of its lines. */
function needles(files) {
  const out = [];
  const walk = (v, where) => {
    if (typeof v === 'string') {
      for (const piece of new Set([v.trim(), ...v.split('\n').map((l) => l.trim())])) {
        if (piece.length >= MIN) out.push({ text: piece, where });
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
  };
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      walk(JSON.parse(line), `${relative(PRIVATE, f)} line ${i + 1}`);
    });
  }
  return out;
}

/** Every file under evals/, and scripts/eval-*. */
function published() {
  const files = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p); else files.push(p);
    }
  };
  walk(join(ROOT, 'evals'));
  for (const name of readdirSync(join(ROOT, 'scripts'))) if (name.startsWith('eval-')) files.push(join(ROOT, 'scripts', name));
  return files;
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const json = (s) => JSON.stringify(s).slice(1, -1);

const files = suiteFiles();
const skip = files.length ? false : `no private suites under ${process.env.OMELETTE_EVALS_DIR ? PRIVATE : '.omelette/evals'} (CI has none): the leak check runs where they exist`;

test('no line of a private prompt, answer or key defect appears under evals/ or in scripts/eval-*', { skip }, () => {
  const found = needles(files);
  assert.ok(found.length > 0, 'the suites hold strings long enough to check');
  const targets = published();
  assert.ok(targets.some((p) => p.endsWith(join('scripts', 'eval-run.mjs'))), 'the scripts are scanned');
  const hits = [];
  for (const target of targets) {
    const text = readFileSync(target, 'utf8');
    for (const n of found) {
      if ([n.text, xml(n.text), json(n.text)].some((form) => text.includes(form))) hits.push(`${relative(ROOT, target)} holds ${n.where}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('package.json `files` does not ship evals/', () => {
  const { files: entries } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const glob = (pat) => new RegExp(`^${pat.split('**').map((p) => p.split('*').map((q) => q.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}(/.*)?$`);
  const ships = (path) => entries.reduce((shipped, e) => {
    const neg = e.startsWith('!');
    return glob(neg ? e.slice(1) : e).test(path) ? !neg : shipped;
  }, false);
  assert.equal(ships('README.md'), true, 'the matcher reads `files` as npm does');
  assert.equal(ships('docs/CONFIG.md'), true);
  for (const p of ['evals/README.md', 'evals/charts/r-accuracy.svg', 'evals/charts/cost.svg']) assert.equal(ships(p), false, p);
});
