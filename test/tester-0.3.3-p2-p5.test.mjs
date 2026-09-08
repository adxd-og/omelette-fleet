/**
 * omelette-fleet :: test/tester-0.3.3-p2-p5.test.mjs
 *
 * Independent coverage for 0.3.3 package P2 and P5 (spec sections 1c, 2, 4, 5,
 * 6 as assigned to this pass): the result spool, its fetch tool, retention,
 * cancellation's interaction with the spool, and the two adapters' `capped`
 * handling meeting deep research's `partial` flag.
 *
 * The implementer's own tests (test/results.test.mjs, test/unit.test.mjs,
 * test/cli.test.mjs, test/doctor-timeouts.test.mjs, test/doctor-prefix.test.mjs,
 * test/hooks.test.mjs, test/codex.test.mjs, test/gemini.test.mjs) are already
 * thorough at the module level. This file targets seams between P1's
 * cancellation machinery and P2's spool that the P1 tester (written before P2
 * landed) could not have checked, plus a few adversarial edges the design spec
 * calls out by name: the spool really lands before the wire response frame in
 * a REAL child process, `detached`/`cancelled` outcomes are spooled with the
 * right header (not just reported to the status feed), retention sorts by
 * `endedAt` even when it disagrees with filename/write order, `<unit>_result`
 * keeps answering a disabled unit, `results: false` still answers the caller,
 * and a symlinked result is refused through the real MCP tool and the CLI, not
 * only through core/results.mjs's own store.
 *
 * Never edits core/*.mjs, units/*.mjs or any implementer test; only adds
 * coverage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../core/jsonrpc.mjs';
import { defineUnit, createUnitRuntime } from '../core/unit.mjs';
import { makeCatalog } from '../core/catalog.mjs';
import { parseResult } from '../core/results.mjs';
import geminiUnit from '../units/gemini/adapter.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const node = process.execPath;

const catalog = makeCatalog({
  models: [{ id: 'm-fast', useFor: 'speed', avoid: 'depth' }],
  efforts: ['low', 'high'],
  guide: 'pick by task',
  title: 'P2P5 TESTER CATALOG',
});

function env(config, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-p2tester-'));
  if (config) writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(config));
  return { dir, env: { ...process.env, OMELETTE_HOME: dir, ...extra } };
}

const spoolDir = (dir, unitName) => join(dir, 'results', unitName);
const spooled = (dir, unitName) => { try { return readdirSync(spoolDir(dir, unitName)).filter((n) => n.endsWith('.md')).sort(); } catch { return []; } };
const readSpooled = (dir, unitName, name) => parseResult(readFileSync(join(spoolDir(dir, unitName), name), 'utf8'));

function fakeUnit(overrides = {}) {
  return defineUnit({
    name: 'p2fake',
    label: 'P2Fake',
    bin: { env: 'P2FAKE_BIN', default: node },
    tools: [
      {
        name: 'p2_delay', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
        async run(args, ctx) {
          const r = await ctx.spawn({
            args: ['-e', `setTimeout(() => process.stdout.write(${JSON.stringify(String(args.text || 'DONE'))}), ${Number(args.ms) || 60})`],
          });
          return r.stdout || `killed=${r.killed}`;
        },
      },
    ],
    catalog,
    ...overrides,
  });
}

const tick = () => new Promise((r) => setImmediate(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- adversarial 1: the spool really lands before the wire response frame ---
// (a REAL child process, real stdio, real serve()) ---------------------------

test('whole stack, real child process: the spool file exists on disk by the time the response FRAME arrives over the real stdio pipe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-p2-wire-'));
  const script = join(dir, 'wire-server.mjs');
  writeFileSync(script, [
    `import { serve } from ${JSON.stringify(new URL('../core/jsonrpc.mjs', import.meta.url).href)};`,
    `import { defineUnit, createUnitRuntime } from ${JSON.stringify(new URL('../core/unit.mjs', import.meta.url).href)};`,
    `import { makeCatalog } from ${JSON.stringify(new URL('../core/catalog.mjs', import.meta.url).href)};`,
    'const catalog = makeCatalog({ models: [{ id: "m" }] });',
    'const unit = defineUnit({',
    '  name: "wirefake", label: "WireFake", bin: { env: null, default: process.execPath },',
    '  tools: [{',
    '    name: "wire_research", kind: "research", description: "d",',
    '    inputSchema: { type: "object", properties: {} },',
    '    async run(args, ctx) {',
    '      const r = await ctx.spawn({ args: ["-e", "setTimeout(() => process.stdout.write(\'WIRE-DONE\'), 40)"] });',
    '      return r.stdout;',
    '    },',
    '  }],',
    '  catalog,',
    '});',
    'const rt = createUnitRuntime(unit, { env: process.env });',
    'serve({ serverInfo: { name: "wirefake", version: "0" }, tools: rt.tools, callTool: rt.callTool });',
  ].join('\n'));
  const child = spawn(node, [script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OMELETTE_HOME: dir },
  });
  child.stderr.on('data', () => {}); // drain, ignore diagnostics
  let buf = '';
  let sawResponseWithSpoolAlreadyOnDisk = false;
  let responseSeen = false;
  const resultsDir = join(dir, 'results', 'wirefake');
  const gotResponse = new Promise((resolve) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          responseSeen = true;
          // THE assertion: by the time these bytes reached the PARENT process
          // over the real stdio pipe, the child had already completed the
          // synchronous spool write (it happens inside finish(), strictly
          // before serve() ever calls process.stdout.write for the response).
          let names = [];
          try { names = readdirSync(resultsDir).filter((n) => n.endsWith('.md')); } catch { /* not yet, or never */ }
          sawResponseWithSpoolAlreadyOnDisk = names.length === 1;
          if (names.length === 1) {
            const body = readFileSync(join(resultsDir, names[0]), 'utf8');
            assert.match(body, /^---\nunit: wirefake\n/);
            assert.ok(body.includes('WIRE-DONE'), 'the spooled text is the answer the wire just carried');
          }
          resolve();
        }
      }
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wire_research', arguments: {} } }) + '\n');
  await gotResponse;
  child.kill();
  assert.equal(responseSeen, true, 'the child never answered at all');
  assert.equal(sawResponseWithSpoolAlreadyOnDisk, true, 'the spool must be on disk strictly before the response frame is observed on the wire');
});

// --- adversarial 2: cancellation outcomes are spooled with the right header,
// not merely reported to the status feed (P1's tester only checked the feed) -

test('cancel `finish`, whole stack: the SPOOLED record (not just the status feed) carries detached: true and status: ok', async () => {
  const { dir, env: e } = env(null); // cancel defaults to "finish"
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const h = createHandler({ serverInfo: { name: 'p2fake', version: '0' }, tools: rt.tools, callTool: rt.callTool });
  const p = h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'p2_delay', arguments: { ms: 250, text: 'FINISH-DONE' } } });
  await wait(60);
  assert.equal(h.inflight(), 1);
  await h({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  const result = await p;
  assert.equal(result, null);
  const names = spooled(dir, 'p2fake');
  assert.equal(names.length, 1, 'the run still owed the caller a spooled answer even though the response was dropped');
  const { header, text } = readSpooled(dir, 'p2fake', names[0]);
  assert.equal(header.status, 'ok', 'the outcome is whatever the abandoned run actually produced');
  assert.equal(header.detached, true, 'the spool itself says nobody was listening, not only the feed');
  assert.equal(header.partial, false);
  assert.equal(text, 'FINISH-DONE', 'the spooled text is the real answer the client never received');
});

test('cancel `kill`, whole stack: the SPOOLED record carries status: cancelled, and detached stays false', async () => {
  const { dir, env: e } = env({ units: { p2fake: { cancel: 'kill' } } });
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const h = createHandler({ serverInfo: { name: 'p2fake', version: '0' }, tools: rt.tools, callTool: rt.callTool });
  const p = h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'p2_delay', arguments: { ms: 5000 } } });
  await wait(60);
  assert.equal(h.inflight(), 1);
  await h({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  const result = await p;
  assert.equal(result, null);
  const names = spooled(dir, 'p2fake');
  assert.equal(names.length, 1, 'a killed run is still spooled — whatever text was captured');
  const { header } = readSpooled(dir, 'p2fake', names[0]);
  assert.equal(header.status, 'cancelled');
  assert.equal(header.detached, false, 'a killed run was not left to finish, so it is never detached');
});

// --- adversarial 3: deep research's cancelled early-return really reaches the
// spool as partial: true, status: cancelled — not only the status feed -------

test('gemini_deep_research cancelled under `cancel: kill`: the spooled record says partial: true and status: cancelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-p2-deepcancel-'));
  const fake = join(dir, 'fake-agy.mjs');
  writeFileSync(fake, [
    'const argv = process.argv.slice(2);',
    'const prompt = argv[argv.indexOf("-p") + 1] || "";',
    'const say = (r) => process.stdout.write(JSON.stringify({ status: "SUCCESS", response: r }));',
    'if (/Decompose the following/.test(prompt)) say(JSON.stringify(["q one", "q two"]));',
    'else setTimeout(() => say("a finding"), 3000);',
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { cancel: 'kill', timeoutS: 60 } } }));
  const base = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const controller = new AbortController();
  const spawns = [];
  const rt = createUnitRuntime(
    {
      ...geminiUnit,
      tools: geminiUnit.tools.map((t) => (t.run ? {
        ...t,
        run: (a, ctx) => t.run(a, {
          ...ctx,
          spawn: (o) => {
            spawns.push(o.args.join(' '));
            if (spawns.length === 2) controller.abort();
            return ctx.spawn({ ...o, args: [fake, ...o.args] });
          },
        }),
      } : t)),
    },
    { env: base },
  );
  await rt.callTool('gemini_deep_research', { question: 'why' }, { id: 1, signal: controller.signal });
  const names = spooled(dir, 'gemini');
  assert.equal(names.length, 1);
  const { header } = readSpooled(dir, 'gemini', names[0]);
  assert.equal(header.status, 'cancelled');
  assert.equal(header.partial, true, 'a cancelled deep-research report never reached synthesis and is partial by definition — the spool must say so, not just the status feed');
});

// --- adversarial 4: retention sorts by endedAt, never by filename ------------

test('retention: the oldest by endedAt is pruned first even when it disagrees with filename / write order', async () => {
  const { dir, env: e } = env({ units: { p2fake: { resultsKeep: 2 } } });
  // Drive core/results.mjs directly with resultIds that are alphabetically
  // REVERSED relative to endedAt: the record with the "newest-looking"
  // filename is actually the OLDEST answer, and retention must not be fooled
  // by that — it must sort on the header's endedAt field, not the filename.
  const { createResultStore } = await import('../core/results.mjs');
  const store = createResultStore({ home: e.OMELETTE_HOME, unit: 'p2fake', keep: 2 });
  // Filename order: -1, -2, -3 (ascending). endedAt order: -3 is OLDEST, -1 is NEWEST.
  store.write({ resultId: '20260908T000000Z-1-1', tool: 't', status: 'ok', startedAt: '2026-09-08T00:00:00.000Z', endedAt: '2026-09-08T23:00:00.000Z', durationMs: 1, text: 'newest-by-endedAt-but-oldest-filename' });
  store.write({ resultId: '20260908T000000Z-1-2', tool: 't', status: 'ok', startedAt: '2026-09-08T00:00:00.000Z', endedAt: '2026-09-08T12:00:00.000Z', durationMs: 1, text: 'middle' });
  store.write({ resultId: '20260908T000000Z-1-3', tool: 't', status: 'ok', startedAt: '2026-09-08T00:00:00.000Z', endedAt: '2026-09-08T01:00:00.000Z', durationMs: 1, text: 'oldest-by-endedAt-but-newest-filename' });
  const survivors = spooled(dir, 'p2fake');
  assert.deepEqual(survivors, ['20260908T000000Z-1-1.md', '20260908T000000Z-1-2.md'],
    'the file with the OLDEST endedAt (-3, alphabetically the "newest" filename) must be the one pruned — proves the sort key is endedAt, not the filename');
  assert.equal(readSpooled(dir, 'p2fake', '20260908T000000Z-1-1.md').text, 'newest-by-endedAt-but-oldest-filename');
});

// --- adversarial 5: <unit>_result (the literal appended tool) keeps answering
// while the unit is disabled -------------------------------------------------

test('<unit>_result (the real appended tool, not a stand-in) answers while the unit is disabled', async () => {
  const { dir, env: e } = env(null);
  const enabledRt = createUnitRuntime(fakeUnit(), { env: e });
  await enabledRt.callTool('p2_delay', { text: 'BEFORE-DISABLE' });
  assert.equal(spooled(dir, 'p2fake').length, 1);

  // Disable the unit IN THE SAME HOME, so the disabled runtime reads the
  // config that turns it off while still seeing the spool the enabled run
  // just wrote — the whole point is one home, two states of "enabled".
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { p2fake: { enabled: false } } }));
  const disabledEnv = { ...process.env, OMELETTE_HOME: dir };
  const disabledRt = createUnitRuntime(fakeUnit(), { env: disabledEnv });
  const r = await disabledRt.callTool('p2fake_result', {});
  assert.equal(r.isError, undefined, `expected a normal answer even though the unit is disabled: ${r.text}`);
  assert.match(r.text, /BEFORE-DISABLE/);
  // The disabled unit's spawning tool still refuses, proving the two paths are
  // genuinely different and this is not simply "everything works".
  const refused = await disabledRt.callTool('p2_delay', {});
  assert.match(refused.text, /disabled in the fleet config/);
});

// --- adversarial 6: results: false still lets the call answer normally ------

test('results: false — the call still answers with its real text; only the spool is switched off', async () => {
  const { dir, env: e } = env({ units: { p2fake: { results: false } } });
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const r = await rt.callTool('p2_delay', { text: 'STILL-ANSWERS' });
  assert.equal(r.isError, undefined);
  assert.equal(r.text, 'STILL-ANSWERS', 'results: false must not touch the answer the caller gets back');
  assert.deepEqual(spooled(dir, 'p2fake'), []);
});

// --- adversarial 7: a symlinked result is refused end-to-end, through the
// real MCP tool and through the CLI — not only through core/results.mjs's own
// unit tests of the store ------------------------------------------------------

test('<unit>_result refuses a symlinked result file end-to-end, through callTool, not just through the store', { skip: process.platform === 'win32' && 'POSIX symlinks' }, async () => {
  const { dir, env: e } = env(null);
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  await rt.callTool('p2_delay', { text: 'real one' });
  const dirPath = spoolDir(dir, 'p2fake');
  const secret = join(dir, 'secret.txt');
  writeFileSync(secret, 'private stuff that must never be readable through the spool');
  const fakeId = '20260101T000000Z-1-999';
  const { symlinkSync: sym } = await import('node:fs');
  sym(secret, join(dirPath, `${fakeId}.md`));
  const r = await rt.callTool('p2fake_result', { id: fakeId });
  assert.equal(r.isError, true);
  assert.doesNotMatch(r.text, /private stuff/);
  assert.match(r.text, /no spooled result/);
});

test('CLI results: a symlinked result file is refused, not printed, and exits 1', { skip: process.platform === 'win32' && 'POSIX symlinks' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-p2-cli-symlink-'));
  const dirPath = join(dir, 'results', 'codex');
  spawnSync(node, ['-e', `require('fs').mkdirSync(${JSON.stringify(dirPath)}, { recursive: true })`]);
  const secret = join(dir, 'secret.txt');
  writeFileSync(secret, 'private');
  const id = '20260101T000000Z-1-1';
  symlinkSync(secret, join(dirPath, `${id}.md`));
  const r = spawnSync(node, [BIN, 'results', 'codex', id], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
  });
  assert.equal(r.status, 1, r.stdout);
  assert.doesNotMatch(r.stdout, /private/);
  assert.match(r.stderr, /no spooled result/);
});

// --- adversarial 8: a traversal-shaped / absolute-path / oversized id never
// reaches the filesystem, through the CLI too ---------------------------------

test('CLI results: an absolute-path id and a 200-char id are refused before any path is built, in one line, exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-p2-cli-badid-'));
  const run = (id) => spawnSync(node, [BIN, 'results', 'codex', id], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
  });
  const abs = run('/etc/passwd');
  assert.equal(abs.status, 1);
  assert.match(abs.stderr, /is not a result id/);
  const long = run('20260908T142501Z-1-' + '9'.repeat(200));
  assert.equal(long.status, 1);
  assert.match(long.stderr, /is not a result id/);
  // Never even the spool directory was created by a lookup.
  assert.equal(existsSync(join(dir, 'results')), false);
});

// --- adversarial 9: two concurrent spawn-tool calls each get their own
// resultId and their own spooled file, even under a shared pid/process -------

test('two calls in the same process get two distinct resultIds and two distinct spooled files, never overwriting each other', async () => {
  const { dir, env: e } = env(null);
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const [a, b] = await Promise.all([
    rt.callTool('p2_delay', { text: 'ANSWER-A', ms: 40 }),
    rt.callTool('p2_delay', { text: 'ANSWER-B', ms: 60 }),
  ]);
  assert.equal(a.text, 'ANSWER-A');
  assert.equal(b.text, 'ANSWER-B');
  const names = spooled(dir, 'p2fake');
  assert.equal(names.length, 2, `expected two distinct spool files, got ${JSON.stringify(names)}`);
  const texts = names.map((n) => readSpooled(dir, 'p2fake', n).text).sort();
  assert.deepEqual(texts, ['ANSWER-A', 'ANSWER-B']);
});
