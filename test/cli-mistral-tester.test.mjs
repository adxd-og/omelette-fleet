/**
 * omelette-fleet :: test/cli-mistral-tester.test.mjs
 * 1.9.0 Task 4 wiring, driven through the CLI as a child process under a temp
 * HOME / OMELETTE_HOME. Every vendor binary is a fake; the real `vibe` is never
 * named (VIBE_BIN always points at a fake or at a path that does not exist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHome } from '../units/mistral/home.mjs';
import { MISTRAL_MODELS } from '../units/mistral/models.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

const tmp = () => mkdtempSync(join(tmpdir(), 'omelette-cli-mistral-'));

function cli(args, { dir, env = {}, timeout = 60000 } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout,
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', signal: r.signal };
}

function fakeVibe(dir) {
  const p = join(dir, 'vibe');
  writeFileSync(p, [
    `#!${process.execPath}`,
    "if (process.argv[2] === '--version') { console.log('vibe 3.1.0'); process.exit(0); }",
    "console.error('unexpected argv: ' + process.argv.slice(2).join(' '));",
    'process.exit(1);',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

/** Doctor with only mistral's binary present; the mistral block comes back alone. */
function mistralBlock({ dir, env = {}, vibe }) {
  const gone = join(dir, 'no-such-cli');
  const r = cli(['doctor'], { dir, env: { AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: gone, VIBE_BIN: vibe, ...env } });
  assert.equal(r.signal, null, 'doctor came back');
  const at = r.out.indexOf('── mistral (');
  assert.ok(at >= 0, r.out + r.err);
  return { block: r.out.slice(at), r };
}

const loginLine = (block) => /^ {2}login {7}(.*)$/m.exec(block)?.[1];

test('doctor login line: ~/.vibe/config.toml or .env counts as present whatever kind of file it is — it is never opened', () => {
  const vibe = fakeVibe(tmp());
  const IN = 'OK — present (~/.vibe/config.toml)';
  const MISSING = 'unknown — absent — run `vibe` once in a terminal and sign in through the browser';

  // A ~/.vibe with neither file, and no ~/.vibe at all.
  const empty = tmp();
  mkdirSync(join(empty, '.vibe'));
  assert.equal(loginLine(mistralBlock({ dir: empty, vibe }).block), MISSING);

  // config.toml missing, .env present: still present.
  const envOnly = tmp();
  mkdirSync(join(envOnly, '.vibe'));
  writeFileSync(join(envOnly, '.vibe', '.env'), 'MISTRAL_API_KEY=never-read\n');
  assert.equal(loginLine(mistralBlock({ dir: envOnly, vibe }).block), IN);

  // A directory, a mode-000 file and a FIFO named config.toml: a read would fail or hang; a stat does not.
  const odd = tmp();
  mkdirSync(join(odd, '.vibe', 'config.toml'), { recursive: true });
  assert.equal(loginLine(mistralBlock({ dir: odd, vibe }).block), IN, 'a directory');

  const locked = tmp();
  mkdirSync(join(locked, '.vibe'));
  writeFileSync(join(locked, '.vibe', 'config.toml'), 'secret');
  chmodSync(join(locked, '.vibe', 'config.toml'), 0o000);
  assert.equal(loginLine(mistralBlock({ dir: locked, vibe }).block), IN, 'mode 000');

  const fifo = tmp();
  mkdirSync(join(fifo, '.vibe'));
  const mk = spawnSync('mkfifo', [join(fifo, '.vibe', 'config.toml')]);
  if (mk.status === 0) assert.equal(loginLine(mistralBlock({ dir: fifo, vibe }).block), IN, 'a FIFO (an open() would block)');
});

test('doctor repro line: the gate follows OMELETTE_ALLOW_REPRO the way the unit reads it', () => {
  const vibe = fakeVibe(tmp());
  const repro = (value) => {
    const dir = tmp();
    const env = value === undefined ? {} : { OMELETTE_ALLOW_REPRO: value };
    return /^ {2}repro {7}(.*)$/m.exec(mistralBlock({ dir, vibe, env }).block)[1];
  };
  const CLOSED = /^closed — set OMELETTE_ALLOW_REPRO=1 on the registration · sandbox-exec (found|macOS only \(1\.9\.0\))$/;
  const OPEN = /^open \(OMELETTE_ALLOW_REPRO=1\) · sandbox-exec (found|macOS only \(1\.9\.0\))$/;
  assert.match(repro(undefined), CLOSED);
  assert.match(repro('1'), OPEN);
  assert.match(repro('true'), OPEN);
  assert.match(repro('0'), CLOSED);
  assert.match(repro(''), CLOSED);
  assert.match(repro('maybe'), CLOSED);
  // The sandbox half is the host's, not the gate's.
  const hasSandbox = existsSync('/usr/bin/sandbox-exec') && process.platform === 'darwin';
  assert.match(repro('1'), hasSandbox ? /sandbox-exec found$/ : /sandbox-exec macOS only \(1\.9\.0\)$/);
});

test('doctor homes line: the newest rendered.json of the two profiles wins; absent or unreadable ones are "not rendered"', () => {
  const vibe = fakeVibe(tmp());
  const dir = tmp();
  const put = (profile, text) => {
    mkdirSync(join(dir, 'vibe', profile), { recursive: true });
    writeFileSync(join(dir, 'vibe', profile, 'rendered.json'), text);
  };
  const homes = () => /^ {2}homes {7}(.*)$/m.exec(mistralBlock({ dir, vibe }).block)[1];
  const base = `${join(dir, 'vibe')}/{review,repro}`;

  put('review', JSON.stringify({ version: '1.9.0', at: '2026-11-07T10:00:00.000Z' }));
  put('repro', JSON.stringify({ version: '1.9.1', at: '2026-11-07T12:00:00.000Z' }));
  assert.equal(homes(), `${base} rendered v1.9.1 at 2026-11-07T12:00:00.000Z`);

  put('repro', JSON.stringify({ version: '1.8.0', at: '2026-11-01T12:00:00.000Z' }));
  assert.equal(homes(), `${base} rendered v1.9.0 at 2026-11-07T10:00:00.000Z`, 'the review sidecar is the newer one now');

  // Corrupt in both: never throws, says not rendered.
  put('review', '{not json');
  put('repro', JSON.stringify({ version: '1.8.0' })); // no `at`
  assert.equal(homes(), `${base} not rendered yet (first call renders them)`);

  // A hostile version string reaches the terminal through `visible`, not raw.
  put('repro', JSON.stringify({ version: '1.9.0\u001b[31m', at: '2026-11-07T12:00:00.000Z' }));
  const line = homes();
  assert.ok(!line.includes('\u001b'), JSON.stringify(line));
  // doctor reads the homes; it renders nothing.
  assert.equal(existsSync(join(dir, 'vibe', 'review', 'config.toml')), false);
});

test('doctor: a registered, enabled mistral with no vibe binary is a FAULT, and its lines still print', () => {
  const dir = tmp();
  const gone = join(dir, 'no-such-cli');
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-mistral': { command: 'node', args: [join(ROOT, 'servers', 'mistral.mjs')] } },
  }));
  const r = cli(['doctor'], { dir, env: { AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: gone, VIBE_BIN: gone } });
  const block = r.out.slice(r.out.indexOf('── mistral ('));
  assert.match(block, /^ {2}login {7}unknown \(no binary\)$/m);
  assert.match(block, /^ {2}FAULT {7}enabled and registered, but: .*not found in PATH/m, r.out);
  assert.match(block, /^ {2}billing {5}MISTRAL_API_KEY scrubbed/m);
  assert.match(block, /^ {2}mcp {9}omelette-mistral registered/m);
  assert.equal(r.code, 1, r.out);
});

test('install and uninstall really drive claude mcp add/remove for <prefix>-mistral', () => {
  const dir = tmp();
  const bindir = join(dir, 'pathdir');
  mkdirSync(bindir);
  const claude = join(bindir, 'claude');
  writeFileSync(claude, [
    `#!${process.execPath}`,
    `require('fs').appendFileSync(${JSON.stringify(join(dir, 'claude.log'))}, process.argv.slice(2).join(' ') + '\\n');`,
    'process.exit(0);',
  ].join('\n'));
  chmodSync(claude, 0o755);
  const PATH = `${bindir}:${process.env.PATH}`;
  const vibe = fakeVibe(tmp());

  const add = cli(['install', '--units', 'mistral', '--prefix', 'zz'], { dir, env: { PATH, VIBE_BIN: vibe } });
  assert.equal(add.code, 0, add.out + add.err);
  const log = readFileSync(join(dir, 'claude.log'), 'utf8');
  assert.ok(log.includes(`mcp add -s user zz-mistral -- node ${join(ROOT, 'servers', 'mistral.mjs')}`), log);

  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'zz-mistral': { command: 'node', args: [join(ROOT, 'servers', 'mistral.mjs')] } },
  }));
  const rm = cli(['uninstall', '--units', 'mistral', '--prefix', 'zz'], { dir, env: { PATH } });
  assert.equal(rm.code, 0, rm.out + rm.err);
  assert.match(rm.out, /removed zz-mistral/);
  assert.match(readFileSync(join(dir, 'claude.log'), 'utf8'), /mcp remove -s user zz-mistral/);
});

test('set: mistral.reproTools is not a key (refused, nothing written); maxPrice and reproKeep refuse the wrong type', () => {
  const dir = tmp();
  const tools = cli(['set', 'mistral.reproTools=bash'], { dir });
  assert.equal(tools.code, 1, tools.out + tools.err);
  assert.match(tools.err, /unknown key "reproTools" for unit "mistral"/);
  assert.equal(existsSync(join(dir, 'fleet.config.json')), false, 'a refused set writes nothing');

  const keep = cli(['set', 'mistral.reproKeep=maybe'], { dir });
  assert.equal(keep.code, 1, keep.out + keep.err);
  assert.equal(existsSync(join(dir, 'fleet.config.json')), false);

  const bare = cli(['set', 'mistral.repro.keep=x'], { dir });
  assert.equal(bare.code, 1, bare.out + bare.err);
  assert.equal(existsSync(join(dir, 'fleet.config.json')), false);
});

test('--help names the mistral unit and VIBE_BIN beside the other vendor overrides', () => {
  const r = cli(['--help'], { dir: tmp() });
  assert.equal(r.code, 0);
  assert.match(r.out, /^ {2}mistral +Mistral via the vibe CLI/m);
  assert.match(r.out, /^ {2}AGY_BIN GROK_BIN CODEX_BIN VIBE_BIN$/m);
});

test('doctor --probe-sandbox asks a registered mistral through its review tool: read-only Vibe tools, in the probe directory, never bash', () => {
  const dir = tmp();
  const gone = join(dir, 'no-such-cli');
  // A vibe that answers --version and records its cwd and argv. It leaves no export.json,
  // so the call itself fails: what is measured here is HOW the probe launched it.
  const marker = join(dir, 'vibe-argv.log');
  mkdirSync(join(dir, 'bin'));
  const vibe = join(dir, 'bin', 'vibe'); // not <fleet home>/vibe: that is where the Vibe homes are rendered
  writeFileSync(vibe, [
    `#!${process.execPath}`,
    "if (process.argv[2] === '--version') { console.log('vibe 3.1.0'); process.exit(0); }",
    `require('fs').appendFileSync(${JSON.stringify(marker)}, process.cwd() + ' ' + process.argv.slice(2).join(' ') + '\\n');`,
    "console.log('refused');",
    'process.exit(0);',
  ].join('\n'));
  chmodSync(vibe, 0o755);
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-mistral': { command: 'node', args: [join(ROOT, 'servers', 'mistral.mjs')] } },
  }));
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: gone, VIBE_BIN: vibe } });
  assert.match(r.out, /── mistral[\s\S]*?\n {2}sandbox {5}\S/, r.out + r.err);

  const runs = readFileSync(marker, 'utf8').trim().split('\n');
  assert.equal(runs.length, 1, runs.join('\n'));
  assert.match(runs[0], /^\S*omelette-probe-mistral-\S+ --workdir \S*omelette-probe-mistral-\S+ /, 'started in the probe directory');
  assert.match(runs[0], /--enabled-tools read_file --enabled-tools grep/);
  assert.doesNotMatch(runs[0], /bash/);

  const spool = join(dir, 'results', 'mistral');
  const record = readFileSync(join(spool, readdirSync(spool).find((f) => f.endsWith('.md'))), 'utf8');
  assert.match(record, /^tool: mistral_security_review$/m);
});

test('ensureHome: a call that renders nothing leaves rendered.json byte for byte as it was; a version bump rewrites it', () => {
  const fleet = tmp();
  const args = { home: fleet, profile: 'repro', models: MISTRAL_MODELS, version: '1.9.0' };
  const first = ensureHome(args);
  assert.equal(first.rendered, true);
  const sidecar = join(first.dir, 'rendered.json');
  // Planted with a time no clock could produce a millisecond ago: a rewrite shows.
  const planted = `${JSON.stringify({ version: '1.9.0', at: '2001-01-01T00:00:00.000Z' })}\n`;
  writeFileSync(sidecar, planted);
  assert.equal(ensureHome(args).rendered, false);
  assert.equal(readFileSync(sidecar, 'utf8'), planted, 'nothing rendered, nothing stamped');
  // A new package version changes the config bytes: rendered again, stamped with that version.
  assert.equal(ensureHome({ ...args, version: '1.9.1' }).rendered, true);
  const now = JSON.parse(readFileSync(sidecar, 'utf8'));
  assert.equal(now.version, '1.9.1');
  assert.ok(Date.parse(now.at) > Date.parse('2001-01-01T00:00:00.000Z') + 1e9);
});

test('rules --print delivers Mistral: the wired-units line, the routing row and the never-a-sole-source bullet', () => {
  const dir = tmp();
  const r = cli(['rules', '--print'], { dir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Gemini, Grok, Codex and Mistral are wired into this session as \*\*read-only units\*\*\./m);
  assert.match(r.out, /^\| Security review by a model that reproduces \|.*`mistral_security_review`.*`mistral_security_repro`.*`OMELETTE_ALLOW_REPRO=1`/m);
  assert.match(r.out, /^- \*\*Mistral\*\*: /m);
});

test('the mistral server\'s initialize answer names Mistral in the fleet contract and mistral_models among the models tools', async () => {
  const dir = tmp();
  const proj = join(dir, 'proj');
  mkdirSync(proj);
  const result = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'servers', 'mistral.mjs')], {
      cwd: proj,
      env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', OMELETTE_STATUS: '0' },
    });
    let buf = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('no initialize answer')); }, 10000);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      p.kill();
      resolve(JSON.parse(buf.slice(0, nl)).result);
    });
    p.stdin.on('error', () => {});
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  });
  assert.match(result.instructions, /one read-only unit of a fleet \(Gemini, Grok, Codex, Mistral\)/);
  assert.match(result.instructions, /\(gemini_models \/ grok_models \/ codex_models \/ mistral_models\)/);
});
