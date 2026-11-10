// 1.10.0 review-fix round, item B (.omelette/briefs/1.10.0-review-fix.md): each
// coder definition renders its own `description:` from a map in core/rules.mjs;
// a template that carries `{{description}}` and a file with no entry is a thrown
// error, never a rendered placeholder. What coder-hard.test.mjs does not pin:
// the throw, "the coder's text plus one sentence" for the other three, and the
// frontmatter being valid (one line, an unquoted YAML scalar) on every path that
// renders a definition — `rules --agents`, `rules --print --agents`, `--global`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const SIX = ['omelette-coder', 'omelette-coder-medium', 'omelette-coder-hard', 'omelette-coder-xhard', 'omelette-tester', 'omelette-reviewer'];
// 1.9.0 shipped this line for the one coder; it is the first words of every coder's description now.
const CODER_DESCRIPTION = 'Implements ONE task from a written brief — code and tests only, no commits unless the brief says so. Spawned by the orchestrating session; reviewed by it afterwards.';

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'omelette-reviewfix-'));
}

function cli(args, { dir, cwd = dir }) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/** The frontmatter lines (between the first `---` and the next) of one definition's text. */
function frontmatter(text) {
  const lines = text.split('\n');
  assert.equal(lines[0], '---', 'the file opens with the frontmatter');
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, 'the frontmatter closes');
  return lines.slice(1, end);
}

/** Asserts the description is one line, an unquoted scalar a YAML reader takes whole. */
function assertValidDescription(text, where) {
  const fm = frontmatter(text);
  const lines = fm.filter((l) => /^description:/.test(l));
  assert.equal(lines.length, 1, `${where}: one description line`);
  const value = lines[0].slice('description:'.length).trim();
  assert.ok(value.length > 0, `${where}: description is not empty`);
  assert.ok(!value.includes(': '), `${where}: no ': ' inside an unquoted scalar: ${value}`);
  assert.ok(!value.includes('`'), `${where}: no backtick inside an unquoted scalar: ${value}`);
  assert.ok(!/ #/.test(value), `${where}: no ' #' (a YAML comment): ${value}`);
  assert.ok(!/^[\[\]{}&*!|>'"%@]/.test(value), `${where}: does not open with a YAML indicator: ${value}`);
  assert.ok(!text.includes('{{'), `${where}: no placeholder survives`);
  return value;
}

/** The six definitions `rules --agents` wrote under <dir>/.claude/agents. */
function written(dir) {
  const agents = join(dir, '.claude', 'agents');
  return Object.fromEntries(readdirSync(agents).map((f) => [f.replace(/\.md$/, ''), readFileSync(join(agents, f), 'utf8')]));
}

test('rules --agents writes six definitions whose frontmatter is valid and whose coder descriptions are the coder\'s text plus its own route', () => {
  const dir = sandbox();
  const r = cli(['rules', '--agents'], { dir });
  assert.equal(r.code, 0, r.err);
  const files = written(dir);
  assert.deepEqual(Object.keys(files).sort(), [...SIX].sort());
  const desc = Object.fromEntries(SIX.map((n) => [n, assertValidDescription(files[n], n)]));
  assert.equal(desc['omelette-coder'], CODER_DESCRIPTION, 'the coder\'s line is byte for byte what 1.9.0 shipped');
  for (const n of ['omelette-coder-medium', 'omelette-coder-hard', 'omelette-coder-xhard']) {
    assert.ok(desc[n].startsWith(`${CODER_DESCRIPTION} `), `${n}: the coder's text first, then one sentence of its own: ${desc[n]}`);
    assert.ok(desc[n].length > CODER_DESCRIPTION.length + 20, `${n}: the added sentence is not empty`);
  }
  assert.equal(new Set(SIX.map((n) => desc[n])).size, SIX.length, 'six distinct descriptions');
  assert.match(desc['omelette-coder-medium'], /[Mm]edium/);
  assert.match(desc['omelette-coder-hard'], /high/);
  assert.match(desc['omelette-coder-xhard'], /xhigh/);
});

test('a --global render and a --print render hold the same six valid descriptions as the project one', () => {
  const dir = sandbox();
  assert.equal(cli(['rules', '--agents'], { dir }).code, 0);
  const project = written(dir);

  const gdir = sandbox();
  const g = cli(['rules', '--agents', '--global'], { dir: gdir });
  assert.equal(g.code, 0, g.err);
  const global = written(gdir);
  for (const n of SIX) {
    assertValidDescription(global[n], `global ${n}`);
    assert.equal(global[n], project[n], `${n}: --global renders the same definition`);
  }

  const p = cli(['rules', '--print', '--agents'], { dir: sandbox() });
  assert.equal(p.code, 0, p.err);
  assert.ok(!p.out.includes('{{'), 'the print shows no placeholder');
  const printed = p.out.split('\n').filter((l) => /^description: /.test(l)).map((l) => l.slice('description: '.length));
  for (const n of SIX) {
    const d = frontmatter(project[n]).find((l) => l.startsWith('description:')).slice('description: '.length);
    assert.ok(printed.includes(d), `${n}: its description is in the print`);
  }
});

test('a template that carries {{description}} and a file with no entry in the map throws and renders nothing', () => {
  // A copy of the package whose tester template carries the placeholder: the
  // tester has no entry in the description map.
  const pkg = sandbox();
  for (const d of ['core', 'agents', 'rules', 'hooks', 'skills']) cpSync(join(ROOT, d), join(pkg, d), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(pkg, 'package.json'));
  const tester = join(pkg, 'agents', 'omelette-tester.md');
  const text = readFileSync(tester, 'utf8').replace(/^description: .*$/m, 'description: {{description}}');
  assert.ok(text.includes('{{description}}'));
  writeFileSync(tester, text);

  const probe = join(sandbox(), 'probe.mjs');
  writeFileSync(probe, `
    import { renderAgentFile } from ${JSON.stringify(pathToFileURL(join(pkg, 'core', 'rules.mjs')).href)};
    let out = 'NO THROW';
    try { out = renderAgentFile('omelette-tester.md', '1.10.0', {}); } catch (e) { out = 'THROW ' + e.message; }
    // the coders still render from the same copy
    const coder = renderAgentFile('omelette-coder-hard.md', '1.10.0', {});
    console.log(JSON.stringify({ out: out.slice(0, 200), coderOk: coder.includes('name: omelette-coder-hard') && !coder.includes('{{') }));
  `);
  const env = { PATH: process.env.PATH, HOME: sandbox(), OMELETTE_HOME: sandbox() };
  const r = spawnSync(process.execPath, [probe], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.match(got.out, /^THROW /, `a missing entry throws: ${got.out}`);
  assert.equal(got.coderOk, true, 'the coders still render');
});
