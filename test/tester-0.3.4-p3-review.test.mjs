/**
 * omelette-fleet :: test/tester-0.3.4-p3-review.test.mjs
 *
 * Independent tester pass on 0.3.4 package 3 ("small items", spec
 * 2026-09-08-0.3.4-design.md §3). The implementer's own tests
 * (test/cli.test.mjs, test/doctor-timeouts.test.mjs, test/unit.test.mjs,
 * test/codex.test.mjs) already cover the headline behaviours of 3a and 3c.
 * This file targets two nuances the spec's own comments call out but that the
 * shipped tests do not exercise directly:
 *
 *  - readClientEnv's scan STOPS at the first file that answers the variable —
 *    so a broken file that sits AFTER the answer in the client's precedence
 *    is never opened by that reader, yet hookWiringAt (which always reads
 *    every settings file) still names it. Doctor must still print exactly
 *    one line about it, and the wall/idle lines must show the value that WAS
 *    found rather than falling back to a default.
 *  - a settings file that exists but cannot be READ at all (a directory sits
 *    where Claude Code expects a file — EISDIR, not ENOENT) is "unreadable"
 *    to readClientEnv, the same as one that parses to garbage; only ENOENT
 *    (truly absent) is silent. hookWiringAt's own read, by contrast, treats
 *    any read failure as "absent" — the two readers are not symmetric, and
 *    doctor's merge still has to produce a sane, non-crashing report.
 *
 * Plus two small gaps in ctx.usedModel's contract (core/unit.mjs, spec §3a):
 * whitespace is trimmed off a reported id, and the new VENDOR_DEFAULT_MODEL
 * export is the literal the runtime actually spools.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineUnit, createUnitRuntime, VENDOR_DEFAULT_MODEL } from '../core/unit.mjs';
import { makeCatalog } from '../core/catalog.mjs';
import { parseResult } from '../core/results.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

const WALL_ENV = 'MCP_TOOL_TIMEOUT';
const IDLE_ENV = 'CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT';

/** A fresh fleet home + HOME per test; a project directory inside it. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-p3-'));
  const proj = join(dir, 'proj');
  mkdirSync(proj, { recursive: true });
  return { dir, proj };
}

/** `doctor` in the project, with no vendor binary anywhere: no probes, no faults. */
function doctor({ dir, proj }, { args = [], env = {} } = {}) {
  const gone = join(dir, 'no-such-cli');
  const r = spawnSync(process.execPath, [BIN, 'doctor', ...args], {
    cwd: proj,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0',
      AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: gone, ...env,
    },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const writeConfig = (dir, config) => writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ version: 1, ...config }));

/** The `mcp timeout` block, label column stripped — read by content, not position. */
function timeoutBlock(out) {
  const lines = out.split('\n');
  const i = lines.findIndex((l) => l.startsWith('mcp timeout   '));
  if (i < 0) return [];
  const block = [lines[i].slice(14)];
  for (let j = i + 1; j < lines.length && lines[j].startsWith('              '); j++) block.push(lines[j].slice(14));
  return block;
}
const lineStartingWith = (out, head) => timeoutBlock(out).find((l) => l.startsWith(head));

/** Every `settings: … unreadable` line doctor printed, in order, label stripped. */
const unreadableLines = (out) => out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('settings: '));
const said = (path) => `settings: ${path} unreadable — env values in it were not consulted`;

// ─── 3c: readClientEnv stops at the first hit; hookWiringAt does not ─────────

test('a value found in a higher-precedence file stops the scan — a broken file AFTER it is never opened by readClientEnv, only named by hookWiringAt', () => {
  const s = sandbox();
  writeConfig(s.dir, { units: { gemini: { enabled: false }, codex: { enabled: false }, grok: { timeoutS: 600 } } });

  mkdirSync(join(s.proj, '.claude'), { recursive: true });
  // settings.local.json is scanned BEFORE settings.json at the same scope
  // (readClientEnv reverses SETTINGS_FILES = ['settings.json', 'settings.local.json']),
  // so both variables are found here and the loop returns before it ever
  // reaches settings.json.
  writeFileSync(
    join(s.proj, '.claude', 'settings.local.json'),
    JSON.stringify({ env: { [WALL_ENV]: '1800000', [IDLE_ENV]: '2700000' } }),
  );
  // Never opened by readClientEnv (the scan already returned), but hookWiringAt
  // reads every file regardless of what it finds, and marks this one broken.
  writeFileSync(join(s.proj, '.claude', 'settings.json'), '{ "env": { "FOO": "bar", } }');

  const localPath = join(realpathSync(s.proj), '.claude', 'settings.local.json');
  const jsonPath = join(realpathSync(s.proj), '.claude', 'settings.json');

  const out = doctor(s).out;
  // The values that WERE found: no silent fallback to the default just
  // because a later, unrelated file in the precedence chain is broken.
  assert.equal(
    lineStartingWith(out, 'wall-clock:'),
    `wall-clock: ${WALL_ENV}=1800000 ms (${localPath} env) ≥ 600000 needed · ok`,
  );
  assert.equal(
    lineStartingWith(out, 'idle:'),
    `idle: ${IDLE_ENV}=2700000 ms (${localPath} env) → 45 min; the longest run is grok.timeoutS=600 s · ok`,
  );
  // Exactly one line, sourced ONLY from the wiring reader — readClientEnv
  // never opened this file at all.
  assert.deepEqual(unreadableLines(out), [said(jsonPath)]);
});

// ─── 3c: a directory where a settings file belongs (EISDIR, not ENOENT) ──────

test('a settings file that is a directory, not a file, is "unreadable" — unlike one that is simply absent — and doctor never crashes over it', () => {
  const s = sandbox();
  writeConfig(s.dir, { units: { gemini: { enabled: false }, codex: { enabled: false }, grok: { timeoutS: 600 } } });

  mkdirSync(join(s.proj, '.claude'), { recursive: true });
  // A directory sits where Claude Code (and this reader) expect a file:
  // readFileSync throws EISDIR, not ENOENT. settings.local.json at the same
  // scope is genuinely absent (never created) and must stay silent.
  mkdirSync(join(s.proj, '.claude', 'settings.json'));
  const jsonPath = join(realpathSync(s.proj), '.claude', 'settings.json');

  const r = doctor(s);
  assert.equal(r.code, 0, 'a directory in place of a settings file is never a fault');
  assert.equal(r.err, '', r.err);
  // Nothing was found anywhere (the directory blocks the one file that could
  // have answered), so both walls fall back to the documented default...
  assert.equal(
    lineStartingWith(r.out, 'wall-clock:'),
    `wall-clock: ${WALL_ENV} unset (default ~28 h) ≥ 600000 needed · ok`,
  );
  // ...and the directory is still named, exactly once — not silently treated
  // as though it were merely absent.
  assert.deepEqual(unreadableLines(r.out), [said(jsonPath)]);
});

// ─── 3a: ctx.usedModel's contract (core/unit.mjs) ─────────────────────────────

const catalog = makeCatalog({
  models: [{ id: 'm-fast', useFor: 'speed', avoid: 'depth' }, { id: 'm-deep' }],
  efforts: ['low', 'high'],
  guide: 'pick by task',
  title: 'TEST CATALOG',
});

/** A minimal unit with one tool that reports the model it pinned itself. */
const pinningUnit = (id) => defineUnit({
  name: 'fakep3',
  bin: { env: 'FAKEP3_BIN', default: process.execPath },
  catalog,
  tools: [
    {
      name: 'fakep3_pin', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
      run(_a, ctx) { ctx.usedModel(id); return `pinned=${id}`; },
    },
  ],
});

function env(config) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-p3-unit-'));
  if (config) writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(config));
  return { dir, env: { ...process.env, OMELETTE_HOME: dir } };
}

const spoolDir = (dir) => join(dir, 'results', 'fakep3');
const spooled = (dir) => readdirSync(spoolDir(dir)).filter((n) => n.endsWith('.md')).sort();
const readSpooled = (dir, name) => parseResult(readFileSync(join(spoolDir(dir), name), 'utf8'));

test('usedModel trims surrounding whitespace before filing it', async () => {
  const { dir, env: e } = env(null);
  const r = await createUnitRuntime(pinningUnit('  m-deep  '), { env: e }).callTool('fakep3_pin', {});
  assert.equal(r.isError, undefined, r.text);
  assert.equal(readSpooled(dir, spooled(dir)[0]).header.model, 'm-deep', 'the header carries the trimmed id, not the padded one');
});

test('VENDOR_DEFAULT_MODEL is the exact literal the runtime spools when nobody named a model', async () => {
  assert.equal(VENDOR_DEFAULT_MODEL, '(vendor default)');
  const { dir, env: e } = env(null);
  // No usedModel call at all — the plain no-report case.
  const plain = defineUnit({
    name: 'fakep3',
    bin: { env: 'FAKEP3_BIN', default: process.execPath },
    catalog,
    tools: [{ name: 'fakep3_plain', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} }, run() { return 'ok'; } }],
  });
  await createUnitRuntime(plain, { env: e }).callTool('fakep3_plain', {});
  assert.equal(readSpooled(dir, spooled(dir)[0]).header.model, VENDOR_DEFAULT_MODEL);
});
