/**
 * omelette-fleet :: test/tester-1.7.0-t1.test.mjs
 * Independent tests for 1.7.0 Task 1 (the skeleton and its delivery), written
 * from docs/superpowers/plans/2026-10-04-1.7.0-fleet-pane.md ("Global
 * constraints", "## Task 1") and the spec's Delivery section — not from the
 * implementation. `claude` is never run: PATH is an empty folder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const MOD = join(ROOT, 'mods', 'omelette-fleet');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pkg = () => readJson(join(ROOT, 'package.json'));
const plugin = () => readJson(join(MOD, '.claude-plugin', 'plugin.json'));
const market = () => readJson(join(ROOT, '.claude-plugin', 'marketplace.json'));
const registerSrc = () => readFileSync(join(MOD, 'hooks', 'register.tsx'), 'utf8');

function snapshot(dir) {
  const seen = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) { seen[relative(dir, path) + '/'] = ''; walk(path); } else seen[relative(dir, path)] = readFileSync(path).toString('base64');
    }
  };
  walk(dir);
  return seen;
}

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'omelette-t1-'));
  const home = join(base, 'home');
  const cwd = join(base, 'project');
  const cfg = join(base, 'claude-config');
  for (const d of [home, cwd, cfg, join(base, 'empty-path')]) mkdirSync(d);
  return { base, home, cwd, cfg };
}

function cli(args, box, extraEnv = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: box.cwd,
    encoding: 'utf8',
    env: { PATH: join(box.base, 'empty-path'), HOME: box.home, OMELETTE_HOME: box.home, CLAUDE_CONFIG_DIR: box.cfg, OMELETTE_UPDATE_CHECK: '0', ...extraEnv },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const lines = (s) => s.split('\n').map((l) => l.trim());

// ---------------------------------------------------------------- manifests

test('plugin.json: name, semver version equal to the package, description, author, types, autoOpen in the planned shape', () => {
  const p = plugin();
  assert.equal(p.name, 'omelette-fleet');
  assert.match(p.version, /^\d+\.\d+\.\d+/);
  assert.equal(p.version, pkg().version);
  assert.equal(p.types, './types/index.d.ts');
  const a = p.userConfig.autoOpen;
  assert.deepEqual(Object.keys(p.userConfig), ['autoOpen'], 'only autoOpen is configurable in T1');
  assert.equal(a.type, 'boolean');
  assert.equal(a.default, true);
  assert.equal(a.title, 'Open the pane at session start');
  assert.equal(typeof a.description, 'string');
  assert.match(a.description, /wide terminal/);
  assert.match(a.description, /\/omelette-fleet command/);
  assert.match(a.description, /status line/);
});

test('marketplace.json: name omelette-fleet, owner adxd-og, one plugin whose source is a relative ./ path to the mod', () => {
  const m = market();
  assert.equal(m.name, 'omelette-fleet');
  assert.equal(m.owner.name, 'adxd-og');
  assert.equal(m.plugins.length, 1);
  const [e] = m.plugins;
  assert.equal(e.name, plugin().name);
  assert.equal(e.source, './mods/omelette-fleet');
  assert.ok(!e.source.includes('..'), 'source stays inside the marketplace root');
  assert.equal(e.description, plugin().description);
  assert.ok(existsSync(join(resolve(ROOT, e.source), '.claude-plugin', 'plugin.json')));
});

test('marketplace and plugin manifests: exactly the install ref `rules --mods` prints', () => {
  const ref = `${plugin().name}@${market().name}`;
  const r = cli(['rules', '--mods'], sandbox());
  assert.ok(lines(r.out).includes(`claude plugin install ${ref}`), r.out);
  assert.ok(lines(r.out).includes(`claude plugin uninstall ${ref}`), r.out);
});

test('hooks.json is exactly { modules: ["./register.tsx"] } and the module is the one file calling `$`', () => {
  const j = readJson(join(MOD, 'hooks', 'hooks.json'));
  assert.deepEqual(j, { modules: ['./register.tsx'] });
  assert.ok(existsSync(join(MOD, 'hooks', 'register.tsx')));
});

test('types/index.d.ts declares PluginState["omelette-fleet"].fleet', () => {
  const t = readFileSync(join(MOD, 'types', 'index.d.ts'), 'utf8');
  assert.match(t, /interface PluginState/);
  // Task 2 filled the placeholder `fleet: unknown` with the fleet model's type.
  assert.match(t, /'omelette-fleet':\s*\{\s*fleet:\s*FleetState\s*\}/);
  for (const name of ['FleetNode', 'FleetLink', 'FleetUsage', 'FleetState']) assert.match(t, new RegExp(`^export type ${name} =`, 'm'), name);
});

test('package.json: files holds mods and .claude-plugin; zero runtime dependencies; node >= 20', () => {
  const p = pkg();
  assert.ok(p.files.includes('mods'));
  assert.ok(p.files.includes('.claude-plugin'));
  assert.ok(!p.dependencies || Object.keys(p.dependencies).length === 0, 'no runtime dependencies');
  assert.ok(!p.optionalDependencies && !p.peerDependencies);
  assert.equal(p.engines.node, '>=20');
  assert.equal(p.scripts.build, undefined, 'no build step');
});

// ------------------------------------------------------------ register.tsx

test('register.tsx: the command, its description, the pane id/title, close, and the dim line — as the plan words them', () => {
  const s = registerSrc();
  assert.match(s, /\$\.command\.register\(/);
  assert.match(s, /name:\s*'omelette-fleet'/);
  assert.ok(s.includes('Show the fleet: agents, units and who is calling whom'));
  assert.match(s, /on\('session\.start'/);
  assert.match(s, /on\('command\.run',\s*\{\s*command:\s*'omelette-fleet'\s*\}/);
  assert.match(s, /on\('ui\.render',\s*\{\s*component:\s*'Pane',\s*requestId:\s*PANE\s*\}/);
  assert.match(s, /const PANE = 'omelette-fleet'/);
  assert.match(s, /const TITLE = 'Fleet'/);
  assert.match(s, /\$\.ui\.open\(\{\s*id:\s*PANE,\s*title:\s*TITLE\s*\}\)/);
  assert.match(s, /\$\.ui\.close\(\{\s*id:\s*PANE\s*\}\)/);
  assert.match(s, /'close'/);
  assert.match(s, /<Text dimColor>No fleet activity yet\.<\/Text>/);
});

test('register.tsx: session.start returns next(e) with the event unchanged; no dynamic import, no node: import, no `$` aliasing', () => {
  const s = registerSrc();
  assert.match(s, /return next\(e\)/);
  assert.ok(!s.includes('import('));
  assert.ok(!/from\s+['"]node:/.test(s));
  assert.ok(!/\bconst\s+\w+\s*=\s*\$\s*[;\n]/.test(s), '$ is never aliased');
  assert.ok(!/\$\[/.test(s), '$ is never indexed dynamically');
  for (const m of s.matchAll(/^import .* from '([^']+)'/gm)) {
    assert.ok(m[1] === 'claude-code' || /\.mjs$/.test(m[1]), `import without extension or unknown package: ${m[1]}`);
  }
});

// ---------------------------------------------------------------- files under mods/

test('files under mods/: no import(, node: or absolute home path (the engine-laid .claude-plugin/types/ aside: it is the engine\'s text, and the pack check below keeps it out of a package)', () => {
  const found = [];
  const laid = join(MOD, '.claude-plugin', 'types');
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (p === laid) continue;
      if (statSync(p).isDirectory()) walk(p); else found.push(p);
    }
  };
  walk(join(ROOT, 'mods'));
  assert.ok(found.length >= 4);
  for (const f of found) {
    const t = readFileSync(f, 'utf8');
    assert.ok(!t.includes('import('), f);
    assert.ok(!t.includes('node:'), f);
    assert.ok(!/\/Users\/|\/home\/(?!op\b)|[A-Za-z]:\\Users\\/.test(t), f);
  }
});

test('committed files of this change hold no absolute home path or personal data', () => {
  const files = [join(ROOT, '.claude-plugin', 'marketplace.json'), join(MOD, '.claude-plugin', 'plugin.json'), join(MOD, 'hooks', 'hooks.json'), join(MOD, 'hooks', 'register.tsx'), join(MOD, 'types', 'index.d.ts'), join(ROOT, 'package.json'), join(ROOT, 'test', 'mod-skeleton.test.mjs')];
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    const body = t;
    assert.ok(!/\/Users\/[A-Za-z]/.test(body), `${f} holds a macOS home path`);
    assert.ok(!/@gmail\.com/.test(body), `${f} holds an e-mail`);
  }
});

// ---------------------------------------------------------------- rules --mods

const MODS_OUT = (() => { const r = cli(['rules', '--mods'], sandbox()); return r; })();

test('rules --mods: exit 0, stderr empty, the two install commands, one-session form and removal each on its own line', () => {
  assert.equal(MODS_OUT.code, 0, MODS_OUT.err);
  assert.equal(MODS_OUT.err, '');
  const L = lines(MODS_OUT.out);
  assert.ok(L.includes(`claude plugin marketplace add ${ROOT}`), MODS_OUT.out);
  assert.ok(L.includes('claude plugin install omelette-fleet@omelette-fleet'));
  assert.ok(L.includes(`claude --plugin-dir ${join(ROOT, 'mods', 'omelette-fleet')}`));
  assert.ok(L.includes('claude plugin uninstall omelette-fleet@omelette-fleet'));
  // order: marketplace add before install
  assert.ok(L.indexOf(`claude plugin marketplace add ${ROOT}`) < L.indexOf('claude plugin install omelette-fleet@omelette-fleet'));
});

test('rules --mods: the three sentences — optional + early access, only reads, the tested build — and the build equals the plan\'s 2.1.294', () => {
  const o = MODS_OUT.out;
  assert.match(o, /optional/i);
  assert.match(o, /early access/i);
  assert.match(o, /only reads/i);
  assert.match(o, /Tested on Claude Code 2\.1\.294/);
  assert.ok(o.split('\n').filter(Boolean).length <= 14, 'output stays short');
});

test('rules --mods names the plan\'s 2.1.294 build consistently with the plan text', () => {
  const plan = readFileSync(join(ROOT, 'docs', 'superpowers', 'plans', '2026-10-04-1.7.0-fleet-pane.md'), 'utf8');
  assert.match(plan, /Tested build: Claude Code 2\.1\.294/);
});

test('rules --mods writes nothing under HOME, the cwd or CLAUDE_CONFIG_DIR for any combination of the other flags — and prints the same', () => {
  const box = sandbox();
  // pre-seed a managed rules file and a foreign one: neither may be touched
  mkdirSync(join(box.cwd, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(box.cwd, '.claude', 'rules', 'omelette-fleet.md'), 'hand-written, no marker\n');
  const before = { h: snapshot(box.home), c: snapshot(box.cwd), g: snapshot(box.cfg) };
  const combos = [
    [], ['--print'], ['--dry-run'], ['--agents'], ['--hooks'], ['--global'], ['--force'],
    ['--print', '--dry-run'], ['--agents', '--hooks', '--global', '--force'], ['--agents', '--hooks', '--force', '--dry-run', '--print'],
    ['--global', '--force', '--agents', '--hooks'],
  ];
  for (const extra of combos) {
    const r = cli(['rules', '--mods', ...extra], box);
    assert.equal(r.code, 0, `${extra.join(' ')}: ${r.err}`);
    assert.equal(r.err, '', extra.join(' '));
    assert.equal(r.out, MODS_OUT.out.replaceAll(ROOT, ROOT), `${extra.join(' ')} printed something else`);
  }
  // flag order does not matter
  const flipped = cli(['rules', '--print', '--agents', '--mods'], box);
  assert.equal(flipped.code, 0);
  assert.equal(flipped.out, MODS_OUT.out);
  assert.deepEqual(snapshot(box.home), before.h, 'HOME changed');
  assert.deepEqual(snapshot(box.cwd), before.c, 'cwd changed');
  assert.deepEqual(snapshot(box.cfg), before.g, 'CLAUDE_CONFIG_DIR changed');
});

test('rules --mods prints no rules text, no settings snippet and no "wrote"/"would write" line', () => {
  const r = cli(['rules', '--mods', '--agents', '--hooks', '--dry-run'], sandbox());
  assert.ok(!/would write|wrote|created|settings\.json|"hooks"/i.test(r.out), r.out);
  assert.ok(!r.out.includes('Working with the omelette fleet'));
});

test('rules --mods --remove is refused (exit 1), with one stderr line naming --mods and the real removal command, in any flag mix; nothing on stdout, nothing written', () => {
  for (const extra of [['--remove'], ['--remove', '--print'], ['--remove', '--dry-run'], ['--remove', '--force', '--global', '--agents', '--hooks']]) {
    const box = sandbox();
    const before = { h: snapshot(box.home), c: snapshot(box.cwd), g: snapshot(box.cfg) };
    const r = cli(['rules', '--mods', ...extra], box);
    assert.equal(r.code, 1, `${extra.join(' ')}: ${r.out}${r.err}`);
    assert.equal(r.out, '', extra.join(' '));
    assert.ok(r.err.includes('--mods'), r.err);
    assert.ok(r.err.includes('claude plugin uninstall omelette-fleet@omelette-fleet'), r.err);
    assert.deepEqual(snapshot(box.home), before.h);
    assert.deepEqual(snapshot(box.cwd), before.c);
    assert.deepEqual(snapshot(box.cfg), before.g);
  }
  // the reason is one line when --mods --remove is the only complaint
  const r = cli(['rules', '--mods', '--remove'], sandbox());
  assert.equal(r.err.trim().split('\n').length, 1, r.err);
});

test('rules --remove (without --mods) and rules --print still behave as before: --mods did not leak into them', () => {
  const box = sandbox();
  const p = cli(['rules', '--print'], box);
  assert.equal(p.code, 0);
  assert.ok(p.out.includes('Working with the omelette fleet'));
  assert.ok(!p.out.includes('claude plugin'));
  const rm = cli(['rules', '--remove'], box);
  assert.equal(rm.code, 0, rm.out + rm.err);
  const both = cli(['rules', '--print', '--remove'], box);
  assert.equal(both.code, 1);
  assert.match(both.err, /opposite things/);
});

test('rules --mods with an unexpected positional or an unknown flag still errors like any rules call', () => {
  const box = sandbox();
  assert.notEqual(cli(['rules', '--mods', 'extra'], box).code, 0);
  assert.notEqual(cli(['rules', '--mods', '--bogus'], box).code, 0);
});

test('rules --mods needs no claude binary, no network and no vendor CLI: it runs under an empty PATH and a read-only-looking HOME that does not exist', () => {
  const box = sandbox();
  const r = cli(['rules', '--mods'], box, { HOME: join(box.base, 'does-not-exist'), OMELETTE_HOME: join(box.base, 'does-not-exist-either') });
  assert.equal(r.code, 0, r.err);
  assert.ok(!existsSync(join(box.base, 'does-not-exist')));
  assert.ok(!existsSync(join(box.base, 'does-not-exist-either')));
});

test('the usage: `help rules` and the global help carry [--mods] and its one line', () => {
  const box = sandbox();
  const h = cli(['help', 'rules'], box);
  assert.ok(h.out.includes('[--mods]'));
  assert.ok(h.out.includes('--mods prints how to install the fleet pane mod and writes nothing.'));
  const all = cli(['--help'], box);
  assert.ok(all.out.includes('[--mods]'), 'global help lists the flag');
  const alt = cli(['rules', '--help'], box);
  assert.ok(alt.out.includes('--mods'), 'rules --help lists the flag');
});

// ---------------------------------------------------------------- npm pack

test('npm pack --dry-run lists the manifests, the plugin files and no engine-laid types, and writes nothing', { timeout: 120000 }, (t) => {
  const box = sandbox();
  const before = snapshot(ROOT.length ? join(ROOT, 'mods') : ROOT);
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, HOME: box.home, npm_config_cache: join(box.base, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' },
  });
  if (r.error || r.status !== 0) { t.skip(`npm unavailable: ${r.error || r.stderr}`); return; }
  const jsonStart = r.stdout.indexOf('[');
  const paths = JSON.parse(r.stdout.slice(jsonStart))[0].files.map((f) => f.path);
  for (const want of ['.claude-plugin/marketplace.json', 'mods/omelette-fleet/.claude-plugin/plugin.json', 'mods/omelette-fleet/hooks/hooks.json', 'mods/omelette-fleet/hooks/register.tsx', 'mods/omelette-fleet/types/index.d.ts']) {
    assert.ok(paths.includes(want), `${want} missing from the package: ${paths.filter((p) => /mods|claude-plugin/.test(p))}`);
  }
  assert.ok(!paths.some((p) => /\.claude-plugin\/types\//.test(p)), 'engine-laid declarations would ship');
  assert.ok(!paths.some((p) => p.startsWith('test/') || p.startsWith('.omelette') || p.startsWith('.claude/')), 'tests or session files ship');
  assert.deepEqual(snapshot(join(ROOT, 'mods')), before, 'npm pack --dry-run wrote under mods/');
});

// ---------------------------------------------------------------- shell quoting (plan: "<package root> is the CLI's own ROOT, shell-quoted")

test('rules --mods shell-quotes a package root with a space and an apostrophe: each printed path is ONE argument to sh, for the marketplace add and the --plugin-dir line',
  { skip: process.platform === 'win32' && 'POSIX quoting' }, () => {
    const box = sandbox();
    const copy = join(box.base, "fleet it's here");
    for (const part of ['bin', 'core', 'units', 'servers', 'examples', 'rules', 'agents', 'skills', 'hooks', 'package.json']) {
      if (existsSync(join(ROOT, part))) cpSync(join(ROOT, part), join(copy, part), { recursive: true });
    }
    const root = realpathSync(copy);
    const r = spawnSync(process.execPath, [join(copy, 'bin', 'omelette-fleet.mjs'), 'rules', '--mods'], {
      cwd: box.cwd, encoding: 'utf8',
      env: { PATH: join(box.base, 'empty-path'), HOME: box.home, OMELETTE_HOME: box.home, OMELETTE_UPDATE_CHECK: '0' },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const [prefix, word] of [['claude plugin marketplace add ', root], ['claude --plugin-dir ', join(root, 'mods', 'omelette-fleet')]]) {
      const line = lines(r.stdout).find((l) => l.startsWith(prefix));
      assert.ok(line, `no line starting ${prefix}: ${r.stdout}`);
      const sh = spawnSync('sh', ['-c', `set -- ${line.slice('claude '.length)}; printf '%s\\n' "$@"`], { encoding: 'utf8' });
      assert.equal(sh.stdout.trimEnd().split('\n').pop(), word, `${line} → ${sh.stdout}${sh.stderr}`);
    }
  });
