// 1.9.0 Task 1, tester's file: lines of the spec / plan the implementer's
// tests leave unpinned (docs/superpowers/plans/2026-11-06-1.9.0-mistral-unit.md
// Task 1 and Task 4 pane line; spec §1 Environment, §2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MISTRAL_MODELS } from '../units/mistral/models.js';
import { ensureHome, renderVibeConfig, renderWrapper, resolveAlias } from '../units/mistral/home.mjs';
import { nodeUp } from '../units/mistral/repro.mjs';
import { layout, plainRows } from '../mods/omelette-fleet/hooks/layout.mjs';

const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));

test('resolveAlias keeps the alias for an unknown id, an unknown effort or a level the family lacks', () => {
  assert.equal(resolveAlias('not-a-model', 'low'), 'not-a-model');
  assert.equal(resolveAlias('glm-5-3', 'bogus'), 'glm-5-3');
  assert.equal(resolveAlias('mistral-large-4-0-3-low', 'max'), 'mistral-large-4-0-3-low', 'Large 4 has no max');
  assert.equal(resolveAlias('mistral-large-4-0-3', undefined), 'mistral-large-4-0-3');
  // the GLM families move across low | high | max, each within itself
  assert.equal(resolveAlias('zai-glm-5-3-flash', 'max'), 'zai-glm-5-3-flash-max');
  assert.equal(resolveAlias('glm-5-3-max', 'low'), 'glm-5-3-low');
  assert.equal(resolveAlias('glm-5-3-low', 'high'), 'glm-5-3');
  // Medium 3.5 offers high | off only
  assert.equal(resolveAlias('mistral-medium-3.5', 'off'), 'mistral-medium-3.5-off');
  assert.equal(resolveAlias('mistral-medium-3.5-off', 'high'), 'mistral-medium-3.5');
  assert.equal(resolveAlias('mistral-medium-3.5', 'low'), 'mistral-medium-3.5');
});

test('the repro and review configs differ only in the marker line and the wrapper path', () => {
  const home = '/fleet-home';
  const review = renderVibeConfig({ models: MISTRAL_MODELS, profile: 'review', home, version: '1.2.3' }).split('\n');
  const repro = renderVibeConfig({ models: MISTRAL_MODELS, profile: 'repro', home, version: '1.2.3' }).split('\n');
  assert.equal(review.length, repro.length);
  const diff = review.map((l, i) => [l, repro[i]]).filter(([a, b]) => a !== b);
  assert.deepEqual(diff, [
    ['# omelette-fleet mistral/review home v1.2.3 — rendered from units/mistral/models.js; edits are overwritten',
      '# omelette-fleet mistral/repro home v1.2.3 — rendered from units/mistral/models.js; edits are overwritten'],
    ['shell = "/fleet-home/vibe/review/shell.sh"', 'shell = "/fleet-home/vibe/repro/shell.sh"'],
  ]);
  assert.throws(() => renderVibeConfig({ models: MISTRAL_MODELS, profile: 'nope', home, version: '1' }), /nope/);
  assert.throws(() => renderWrapper({ profile: 'nope', home }), /nope/);
});

test('ensureHome refuses a regular file or a directory where a home path or a managed file belongs, and writes nothing through it', () => {
  const asFile = tmp('omelette-mistral-t-');
  mkdirSync(join(asFile, 'vibe'));
  writeFileSync(join(asFile, 'vibe', 'review'), 'precious');
  assert.throws(() => ensureHome({ home: asFile, profile: 'review' }), (e) => e.message.includes(join(asFile, 'vibe', 'review')));
  assert.equal(readFileSync(join(asFile, 'vibe', 'review'), 'utf8'), 'precious');

  const vibeFile = tmp('omelette-mistral-t-');
  writeFileSync(join(vibeFile, 'vibe'), 'precious');
  assert.throws(() => ensureHome({ home: vibeFile, profile: 'review' }), (e) => e.message.includes(join(vibeFile, 'vibe')));
  assert.equal(readFileSync(join(vibeFile, 'vibe'), 'utf8'), 'precious');

  const dirAtName = tmp('omelette-mistral-t-');
  mkdirSync(join(dirAtName, 'vibe', 'repro', 'repro.sb'), { recursive: true });
  assert.throws(() => ensureHome({ home: dirAtName, profile: 'repro' }), (e) => e.message.includes('repro.sb'));
});

test('ensureHome writes the modes of the plan (config 0600, shell.sh 0700, repro.sb 0600) and logs what it rendered', async () => {
  const { statSync } = await import('node:fs');
  const home = tmp('omelette-mistral-t-');
  const lines = [];
  const { dir } = ensureHome({ home, profile: 'repro', log: (l) => lines.push(l) });
  const mode = (n) => statSync(join(dir, n)).mode & 0o777;
  assert.equal(mode('config.toml'), 0o600);
  assert.equal(mode('shell.sh'), 0o700);
  assert.equal(mode('repro.sb'), 0o600);
  assert.equal(lines.length, 3);
  assert.equal(statSync(join(home, 'vibe')).mode & 0o777, 0o700);
  // a version bump in the marker alone re-renders the config and nothing else
  const again = [];
  assert.equal(ensureHome({ home, profile: 'repro', version: '0.0.1', log: (l) => again.push(l) }).rendered, true);
  assert.deepEqual(again, [`mistral: rendered ${join(dir, 'config.toml')}`]);
  // the two profiles are two homes
  assert.notEqual(ensureHome({ home, profile: 'review' }).dir, dir);
});

test('both wrappers parse under bash -n with a home holding a space, a quote and a dollar, and the config path round-trips', () => {
  const home = "/tmp/fleet home's $x";
  for (const profile of ['review', 'repro']) {
    const dir = tmp('omelette-mistral-t-');
    const file = join(dir, 'shell.sh');
    writeFileSync(file, renderWrapper({ profile, home }));
    const r = spawnSync('/bin/bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const cfg = renderVibeConfig({ models: MISTRAL_MODELS, profile, home, version: '1' }).split('\n');
    const shell = cfg.find((l) => l.startsWith('shell = '));
    assert.equal(JSON.parse(shell.slice('shell = '.length)), `${home}/vibe/${profile}/shell.sh`);
  }
});

test('the wrapper intercepts only the login-env probe: a -lc command or a -c command that merely names it gets no env dump, and the review wrapper refuses it', () => {
  const dir = tmp('omelette-mistral-t-');
  const wrapper = join(dir, 'shell.sh');
  writeFileSync(wrapper, renderWrapper({ profile: 'review', home: join(dir, 'fleet') }));
  chmodSync(wrapper, 0o700);
  const env = { PATH: '/usr/bin:/bin', OMELETTE_T: '1' };
  // Neither is the probe: no env dump on stdout; the review wrapper refuses them (exit 126) instead of running them.
  for (const args of [['-lc', 'echo plain'], ['-c', 'echo mistralai-vibe-login-env-abc; echo done']]) {
    const r = spawnSync(wrapper, args, { env });
    assert.equal(r.status, 126, args.join(' '));
    assert.equal(r.stdout.toString(), '', args.join(' '));
    assert.match(r.stderr.toString(), /review profile has no shell/);
  }
});

test('the repro wrapper answers the probe before any sandbox-exec: no clone or tmp in the env needed, no sandbox in the output', () => {
  const dir = tmp('omelette-mistral-t-');
  const wrapper = join(dir, 'shell.sh');
  writeFileSync(wrapper, renderWrapper({ profile: 'repro', home: join(dir, 'fleet') }));
  chmodSync(wrapper, 0o700);
  const marker = 'mistralai-vibe-login-env-00112233aabbccdd';
  const out = execFileSync(wrapper, ['-lc', `printf '%s' ${marker}; exec env -0`], { env: { PATH: '/usr/bin:/bin', OMELETTE_T: '1' } }).toString();
  assert.ok(out.startsWith(marker));
  assert.ok(out.slice(marker.length).split('\0').includes('OMELETTE_T=1'));
  assert.ok(out.endsWith('\0'));
});

test('the repro wrapper runs bash under the kernel profile: a write in the clone lands; a write outside, a connect to a live loopback listener and a read of ~/.ssh are refused, with a home path holding a space and a quote', { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') }, async () => {
  // sandbox-exec cannot nest: when this process is already inside a sandbox, an
  // allow-everything profile fails too, and only then is the test skipped.
  if (spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status !== 0) return;
  const base = tmp("omelette mistral q'");
  const fleet = join(base, "fleet home's");
  const { dir } = ensureHome({ home: fleet, profile: 'repro' });
  const clone = join(base, 'clone');
  const tmpd = join(base, 'tmp');
  const out = join(base, 'out');
  const home = join(base, 'h');
  mkdirSync(clone);
  mkdirSync(tmpd);
  mkdirSync(out);
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id'), 'secret\n');
  // Writable to a command: only the clone and its tmp (the profile no longer opens /private/var/folders); the outside is /private/tmp.
  const outside = `/private/tmp/omelette-mistral-t-outside-${process.pid}`;
  // A listener that works, so a refused connect is the kernel's doing and not a dead network.
  const server = createServer((req, res) => res.end('reachable')).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const env = { PATH: '/usr/bin:/bin', HOME: home, OMELETTE_REPRO_CLONE: clone, OMELETTE_REPRO_TMP: tmpd, OMELETTE_FLEET_HOME: fleet, OMELETTE_REPRO_OUT: out, OMELETTE_REPRO_RUNS: join(base, 'runs'), OMELETTE_REPRO_RUN: base, OMELETTE_REPRO_TMPROOT: realpathSync(tmpdir()), OMELETTE_REPRO_SRC: join(base, 'src'), OMELETTE_REPRO_NODE: realpathSync(dirname(dirname(process.execPath))), OMELETTE_REPRO_NODEUP: nodeUp({ home, node: realpathSync(dirname(dirname(process.execPath))) }), T_HOME: home, T_OUT: outside };
    const run = (cmd) => new Promise((resolve) => execFile(join(dir, 'shell.sh'), ['-c', cmd], { env }, (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));
    assert.equal((await run('echo hi')).stdout, 'hi\n');
    assert.equal((await run('echo x > "$OMELETTE_REPRO_CLONE/in"')).status, 0);
    assert.equal(readFileSync(join(clone, 'in'), 'utf8'), 'x\n');
    const w = await run('echo x > "$T_OUT"');
    assert.notEqual(w.status, 0);
    assert.match(w.stderr, /Operation not permitted/);
    assert.equal(existsSync(outside), false);
    const net = await run(`/usr/bin/curl -sS -m 5 http://127.0.0.1:${port}/`);
    assert.notEqual(net.status, 0, `loopback reached: ${net.stdout}`);
    assert.doesNotMatch(net.stdout, /reachable/);
    const ssh = await run('cat "$T_HOME/.ssh/id"');
    assert.notEqual(ssh.status, 0);
    assert.doesNotMatch(ssh.stdout, /secret/);
    // control: the same listener answers outside the sandbox, so the refusals above are the profile's
    const control = await new Promise((resolve) => execFile('/usr/bin/curl', ['-sS', '-m', '5', `http://127.0.0.1:${port}/`], (err, stdout) => resolve(err ? `ERR ${err.message}` : stdout)));
    assert.equal(control, 'reachable');
  } finally {
    server.close();
    rmSync(outside, { force: true });
  }
});

test('the pane draws the four-unit graph from 71 columns and the tree at 70 (GRAPH_MIN is exactly 71)', () => {
  const NOW = Date.UTC(2026, 9, 8, 9, 6, 0);
  const unit = (name, order) => ({ id: `unit:${name}`, kind: 'unit', role: name, status: 'idle', since: NOW - 3600000, feed: 'ok', order });
  const state = {
    now: NOW, isOpen: true, usage: {}, history: [],
    nodes: [
      { id: 'main', kind: 'orchestrator', role: 'orchestrator', status: 'running', since: NOW - 60000, order: 0 },
      ...['gemini', 'grok', 'codex', 'mistral'].map((n, i) => unit(n, i + 1)),
    ],
  };
  const draw = (columns) => plainRows(layout(state, { columns, rows: 30, isAscii: false, tzOffsetAt: () => 0 }));
  const graph = draw(71);
  const tree = draw(70);
  assert.ok(graph.some((r) => r.includes('└───────────────┘ └───────────────┘ └───────────────┘ └───────────────┘')), 'four boxes side by side at 71');
  assert.ok(!tree.some((r) => r.includes('└───')), 'no boxes at 70');
  assert.ok(tree.some((r) => r.includes('mistral')), 'the tree lists the fourth unit');
});
