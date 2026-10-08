/**
 * omelette-fleet :: test/mod-skeleton.test.mjs
 * The fleet pane's skeleton and its delivery (1.7.0, Task 1): the plugin
 * folder under mods/, the package root as a folder marketplace, the files npm
 * ships, and `rules --mods`, which PRINTS how to install the mod and writes
 * nothing. No test here runs `claude`: the manifests are read as files, and
 * the CLI runs as a child process with PATH emptied, a temp HOME and a temp
 * cwd, as in cli.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellWord } from '../core/rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const MOD = join(ROOT, 'mods', 'omelette-fleet');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const pkg = () => readJson(join(ROOT, 'package.json'));
const plugin = () => readJson(join(MOD, '.claude-plugin', 'plugin.json'));
const marketplace = () => readJson(join(ROOT, '.claude-plugin', 'marketplace.json'));

/** Every file and folder under `dir`, with each file's bytes: two snapshots are equal only when nothing was written. */
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

/** A sandbox: a temp HOME (the fleet home too) and a temp cwd, apart from each other and from the package. */
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'omelette-mods-'));
  const home = join(base, 'home');
  const cwd = join(base, 'project');
  mkdirSync(home);
  mkdirSync(cwd);
  return { base, home, cwd };
}

/** The CLI at `bin`, with PATH pointing at an empty folder: no `claude`, no vendor CLI, no network. */
function cli(bin, args, { home, cwd, base }) {
  const empty = join(base, 'empty-path');
  mkdirSync(empty, { recursive: true });
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: empty, HOME: home, OMELETTE_HOME: home, OMELETTE_UPDATE_CHECK: '0' },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

test('the plugin manifest: named omelette-fleet, at the package version, with a one-line description, its types file and the autoOpen option', () => {
  const p = plugin();
  assert.equal(p.name, 'omelette-fleet');
  assert.equal(p.version, pkg().version, 'the plugin version must equal package.json\'s');
  assert.equal(typeof p.description, 'string');
  assert.ok(p.description.length > 0 && !p.description.includes('\n'), p.description);
  assert.equal(typeof p.types, 'string');
  assert.ok(existsSync(resolve(MOD, p.types)), `types names a file that does not exist: ${p.types}`);
  assert.equal(p.userConfig.autoOpen.type, 'boolean');
  assert.equal(p.userConfig.autoOpen.default, true);
});

test('hooks.json names exactly one module, and that module exists', () => {
  const hooksJson = join(MOD, 'hooks', 'hooks.json');
  const { modules } = readJson(hooksJson);
  assert.ok(Array.isArray(modules), 'modules is a list');
  assert.equal(modules.length, 1, `exactly one module: ${JSON.stringify(modules)}`);
  assert.ok(existsSync(resolve(dirname(hooksJson), modules[0])), `the module does not exist: ${modules[0]}`);
});

test('the marketplace: its one plugin\'s source resolves to a folder holding the plugin manifest, under the same name and description', () => {
  const m = marketplace();
  assert.equal(m.plugins.length, 1, JSON.stringify(m.plugins));
  const [entry] = m.plugins;
  const folder = resolve(ROOT, entry.source);
  assert.ok(statSync(folder).isDirectory(), `source is not a folder: ${entry.source}`);
  const manifest = join(folder, '.claude-plugin', 'plugin.json');
  assert.ok(existsSync(manifest), `no plugin manifest under ${entry.source}`);
  const p = readJson(manifest);
  assert.equal(entry.name, p.name);
  assert.equal(entry.description, p.description);
  // What `rules --mods` prints to install it.
  assert.equal(`${p.name}@${m.name}`, 'omelette-fleet@omelette-fleet');
});

test('package.json ships the mod and the marketplace', () => {
  const { files } = pkg();
  assert.ok(files.includes('mods'), JSON.stringify(files));
  assert.ok(files.includes('.claude-plugin'), JSON.stringify(files));
});

test('no file under mods/ holds import(, node: or an absolute home path (the engine\'s own .claude-plugin/types/ aside)', () => {
  // The engine lays this build's declarations into <mod>/.claude-plugin/types/
  // at every load from a folder (gitignored by the engine itself); they are its
  // text, not the mod's, and they name this machine's MCP servers.
  const laid = join(MOD, '.claude-plugin', 'types');
  // A macOS, Linux or Windows home; `/home/op` is the fixtures' made-up one.
  const homePath = /(?:\/Users\/|\/home\/(?!op\b)|[A-Za-z]:\\Users\\)[^\s/\\'"`]+/;
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (path === laid) continue;
      if (statSync(path).isDirectory()) walk(path); else files.push(path);
    }
  };
  walk(join(ROOT, 'mods'));
  assert.ok(files.includes(join(MOD, 'hooks', 'register.tsx')), 'the scan reached the hooks module');
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    const name = relative(ROOT, path);
    assert.ok(!text.includes('import('), `${name} holds import(`);
    assert.ok(!text.includes('node:'), `${name} holds node:`);
    assert.doesNotMatch(text, homePath, `${name} holds an absolute home path`);
  }
});

test('rules --mods prints the install commands, the one-session form and the removal, and writes nothing — --print, --dry-run and the render flags change none of it', () => {
  const box = sandbox();
  const before = { home: snapshot(box.home), cwd: snapshot(box.cwd) };
  const runs = [['rules', '--mods'], ['rules', '--mods', '--print'], ['rules', '--mods', '--dry-run'], ['rules', '--mods', '--agents', '--hooks', '--global']]
    .map((args) => ({ args, ...cli(BIN, args, box) }));
  for (const r of runs) {
    assert.equal(r.code, 0, `${r.args.join(' ')}: ${r.out}${r.err}`);
    assert.equal(r.err, '', `${r.args.join(' ')}: ${r.err}`);
    assert.equal(r.out, runs[0].out, `${r.args.join(' ')} printed something else than rules --mods`);
  }
  const lines = runs[0].out.split('\n').map((l) => l.trim());
  assert.ok(lines.includes(`claude plugin marketplace add ${shellWord(ROOT)}`), runs[0].out);
  assert.ok(lines.includes('claude plugin install omelette-fleet@omelette-fleet'), runs[0].out);
  assert.ok(lines.includes(`claude --plugin-dir ${shellWord(join(ROOT, 'mods', 'omelette-fleet'))}`), runs[0].out);
  assert.ok(lines.includes('claude plugin uninstall omelette-fleet@omelette-fleet'), runs[0].out);
  assert.match(runs[0].out, /optional/i);
  assert.match(runs[0].out, /early access/i);
  assert.match(runs[0].out, /only reads/i);
  assert.match(runs[0].out, /Tested on Claude Code \d+\.\d+\.\d+/);
  assert.deepEqual(snapshot(box.home), before.home, 'rules --mods wrote under HOME');
  assert.deepEqual(snapshot(box.cwd), before.cwd, 'rules --mods wrote under the cwd');
});

test('rules --mods quotes a package root that holds a space, and a shell reads it as one word',
  { skip: process.platform === 'win32' && 'POSIX quoting' }, () => {
    const box = sandbox();
    const copy = join(box.base, 'fleet with space');
    for (const part of ['bin', 'core', 'units', 'servers', 'examples', 'rules', 'agents', 'skills', 'hooks', 'package.json']) {
      cpSync(join(ROOT, part), join(copy, part), { recursive: true });
    }
    // The CLI names its root by its own real location (a macOS temp dir is /private/var/…).
    const root = realpathSync(copy);
    const r = cli(join(copy, 'bin', 'omelette-fleet.mjs'), ['rules', '--mods'], box);
    assert.equal(r.code, 0, r.out + r.err);
    const add = r.out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('claude plugin marketplace add '));
    assert.equal(add, `claude plugin marketplace add '${root}'`, r.out);
    const dir = r.out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('claude --plugin-dir '));
    assert.equal(dir, `claude --plugin-dir '${join(root, 'mods', 'omelette-fleet')}'`, r.out);
    // What the operator pastes: the path is ONE argument to a POSIX shell.
    for (const [line, word] of [[add, root], [dir, join(root, 'mods', 'omelette-fleet')]]) {
      const words = spawnSync('sh', ['-c', `set -- ${line.slice('claude '.length)}; printf '%s\\n' "$@"`], { encoding: 'utf8' });
      assert.equal(words.stdout.trim().split('\n').pop(), word, words.stdout + words.stderr);
    }
  });

test('rules --mods --remove is refused with a one-line reason, and writes nothing', () => {
  const box = sandbox();
  const before = { home: snapshot(box.home), cwd: snapshot(box.cwd) };
  const r = cli(BIN, ['rules', '--mods', '--remove'], box);
  assert.notEqual(r.code, 0, r.out + r.err);
  assert.equal(r.out, '', r.out);
  const reason = r.err.trim().split('\n');
  assert.equal(reason.length, 1, r.err);
  assert.match(reason[0], /--mods/);
  assert.match(reason[0], /claude plugin uninstall omelette-fleet@omelette-fleet/);
  assert.deepEqual(snapshot(box.home), before.home);
  assert.deepEqual(snapshot(box.cwd), before.cwd);
});

test('the rules usage names --mods', () => {
  const box = sandbox();
  const r = cli(BIN, ['help', 'rules'], box);
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(r.out.includes('[--mods]'), r.out);
  assert.match(r.out, /--mods prints/, r.out);
});
