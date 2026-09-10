/**
 * omelette-fleet :: test/tester-0.3.7-review.test.mjs
 * Independent coverage for the 0.3.7 diff (M1 — the fleet contract, M2 — the
 * spawn tail queue), written from docs/superpowers/specs/2026-09-10-0.3.7-design.md
 * against the working tree, not against the implementer's own tests. Never
 * edits core/rules.mjs, core/spawn.mjs, bin/omelette-fleet.mjs or any test the
 * implementer wrote.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../core/spawn.mjs';
import { FLEET_CONTRACT, SHORT_CONTRACT, contractFor, renderRulesFile, rulesTarget } from '../core/rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const node = process.execPath;

/* ------------------------------------------------------------------------ *
 * M2 — the tail queue: two scenarios the implementer's own fuzz/mega test
 * does not specifically exercise — `capped` after a mid-stream drop whose
 * remainder lands EXACTLY on the cap (so the final "slice the head chunk"
 * branch never runs), and a multi-chunk drop verified against a reference.
 * ------------------------------------------------------------------------ */

test('capped stays true after a mid-stream drop even when the remaining tail lands exactly on the cap', async () => {
  // Two 5-byte writes, cap 5: chunk 1 must be DROPPED once chunk 2 arrives
  // (total 10 - chunks[0].length 5 = 5 >= cap 5), leaving total === cap, so
  // the close handler's `if (capping && total > outputCap)` branch is skipped
  // entirely. `capped` must still be true because a chunk really was dropped —
  // it must not depend on the final slice having run.
  const r = await runProcess({
    bin: node,
    args: ['-e', 'process.stdout.write("AAAAA"); process.stdout.write("BBBBB")'],
    outputCap: 5,
  });
  assert.equal(r.stdout, 'BBBBB');
  assert.equal(r.capped, true, 'a chunk was dropped even though the remainder landed exactly on the cap');
});

test('the queue drops exactly enough whole chunks to keep the true tail, across several chunks', async () => {
  // Five chunks of 4 bytes each ("0000".."4444"), cap 10: the true tail of the
  // 20-byte stream is the last 10 characters, spanning the boundary between
  // chunk 2 and chunk 3 ("22" + "3333" + "4444"). This is a reference-checked
  // regression for the sliding-window drop loop, independent of chunk size —
  // a subtly wrong `>=`/`>`/off-by-one would fail it while still passing the
  // implementer's exact-cap and inside-a-chunk cases.
  const full = ['0', '1', '2', '3', '4'].map((d) => d.repeat(4)).join('');
  const writes = ['0', '1', '2', '3', '4'].map((d) => `process.stdout.write(${JSON.stringify(d.repeat(4))});`).join('\n');
  const r = await runProcess({ bin: node, args: ['-e', writes], outputCap: 10 });
  assert.equal(r.stdout, full.slice(-10));
  assert.equal(r.stdout, '22' + '3333' + '4444');
  assert.equal(r.capped, true);
});

/* ------------------------------------------------------------------------ *
 * M1 — the fleet contract: the marker test is promised to look at LINE 1
 * only, and to read "at most 8 KiB" — neither boundary is exercised by the
 * implementer's contractFor tests, which only vary "no marker" vs "marker on
 * line 1".
 * ------------------------------------------------------------------------ */

/** A cwd/env pair with no rules file of ours reachable in either scope. */
function nowhere() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-0-3-7-'));
  mkdirSync(join(dir, 'global'), { recursive: true });
  return { cwd: dir, env: { OMELETTE_HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'global') } };
}

test('a real marker one line too late is not recognised — the file is treated as none of ours', () => {
  const o = nowhere();
  const { path } = rulesTarget({ cwd: o.cwd, env: o.env });
  mkdirSync(dirname(path), { recursive: true });
  // The exact marker text `renderRulesFile` produces, but pushed to line 2 by
  // a leading blank line — a plausible mistake for an operator hand-editing
  // the file, and exactly the case "only line 1 is looked at" promises to
  // reject.
  writeFileSync(path, '\n' + renderRulesFile('1.2.3'));
  assert.deepEqual(contractFor(o), { text: FLEET_CONTRACT, short: false, reason: `no rules file in ${o.cwd}` });
});

test('the marker is still found in a rules file far larger than the 8 KiB read bound', () => {
  const o = nowhere();
  const { path } = rulesTarget({ cwd: o.cwd, env: o.env });
  mkdirSync(dirname(path), { recursive: true });
  // A legitimate rendered file (marker on line 1, tiny) followed by a huge
  // body — the read bound exists so a large PROJECT file does not slow down
  // every server start, and detection must still succeed because the marker
  // itself sits well inside the first 8 KiB.
  const big = renderRulesFile('1.2.3') + 'x'.repeat(200_000) + '\n';
  writeFileSync(path, big);
  assert.deepEqual(contractFor(o), { text: SHORT_CONTRACT, short: true, reason: 'rules installed here' });
});

test('short contract plus the unit line, for every unit server — not only codex', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-0-3-7-init-'));
  const proj = join(dir, 'proj');
  mkdirSync(proj, { recursive: true });
  assert.equal(
    spawnSync(process.execPath, [BIN, 'rules', '--force'], {
      cwd: proj,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
    }).status,
    0,
  );
  for (const [unit, ownLineRe] of [['gemini', /\n\nThis unit: Gemini/], ['grok', /\n\nThis unit: Grok/]]) {
    const res = await initializeServer(join(ROOT, 'servers', `${unit}.mjs`), dir, proj);
    assert.ok(res.instructions.startsWith(SHORT_CONTRACT), `${unit}: ${res.instructions.slice(0, 200)}`);
    assert.match(res.instructions, ownLineRe, `${unit}: keeps its own line under the short contract too`);
  }
});

/** Minimal MCP `initialize` round-trip over real stdio, returning `instructions`. */
function initializeServer(serverPath, homeDir, cwd, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [serverPath], {
      cwd,
      env: { PATH: process.env.PATH, HOME: homeDir, OMELETTE_HOME: homeDir, OMELETTE_UPDATE_CHECK: '0', OMELETTE_STATUS: '0' },
    });
    let buf = '';
    let err = '';
    let done = false;
    const settle = (fn, v) => { if (done) return; done = true; clearTimeout(timer); p.kill(); fn(v); };
    const timer = setTimeout(() => settle(reject, new Error(`${serverPath}: no reply in ${timeoutMs}ms · stderr: ${err.trim() || '(none)'}`)), timeoutMs);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const msg = JSON.parse(buf.slice(0, nl));
        settle(resolve, msg.result);
      } catch { /* fragment; wait for more */ }
    });
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', (e) => settle(reject, e));
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-01-01' } }) + '\n');
    p.on('close', (code, signal) => settle(reject, new Error(`${serverPath}: exited (code ${code}, signal ${signal}) before replying · stderr: ${err.trim() || '(none)'}`)));
  });
}

/* ------------------------------------------------------------------------ *
 * End-to-end gaps: the implementer's CLI `set contract=` test never starts a
 * real server, and the implementer's server tests never go through the real
 * `set` command — each half is proven, the seam between them is not.
 * ------------------------------------------------------------------------ */

test('omelette-fleet set contract=short, end to end: a freshly started server actually sends the short line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-0-3-7-e2e-'));
  const proj = join(dir, 'proj');
  mkdirSync(proj, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' };

  // No rules file anywhere: baseline is the full contract.
  const before = await initializeServer(join(ROOT, 'servers', 'codex.mjs'), dir, proj);
  assert.ok(before.instructions.startsWith(FLEET_CONTRACT));

  const set = spawnSync(process.execPath, [BIN, 'set', 'contract=short'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(set.status, 0, set.stdout + set.stderr);

  const after = await initializeServer(join(ROOT, 'servers', 'codex.mjs'), dir, proj);
  assert.ok(after.instructions.startsWith(SHORT_CONTRACT), after.instructions.slice(0, 200));
  assert.match(after.instructions, /\n\nThis unit: Codex/);
});

test('show fleet: an invalid contract value written directly to the config file warns rather than failing the command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-0-3-7-warn-'));
  const env = { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' };
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ version: 1, contract: 'loud' }));
  const r = spawnSync(process.execPath, [BIN, 'show', 'fleet'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ {2}warning {2}fleet config: contract = "loud" is invalid — ignored$/m, r.stdout);
  // The table itself still shows the built-in default, not the rejected value.
  assert.match(r.stdout, /^\s+contract\s+auto\s+default$/m, r.stdout);

  // A malformed (non-JSON) config file is the harsher case: `show fleet` must
  // still answer rather than crash.
  writeFileSync(join(dir, 'fleet.config.json'), '{ not json');
  const broken = spawnSync(process.execPath, [BIN, 'show', 'fleet'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(broken.status, 0, broken.stdout + broken.stderr);
  assert.match(broken.stdout, /^fleet$/m);
  assert.match(broken.stdout, /contract\s+auto\s+default/);
});
