// Independent coverage for 1.3.0 P0 Task 7 (S2): codex_image excludes /tmp and
// $TMPDIR from workspace-write's writable roots. Written from the plan
// contract, not from the implementer's own test file — nothing is imported
// from test/codex.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import unit, { buildArgs } from '../units/codex/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- buildArgs: excludeTmp, both modes, both booleans, exact order ----------

test('buildArgs: excludeTmp=true inserts both overrides right after tools.web_search, in order, before -C', () => {
  for (const mode of ['workspace-write', 'read-only']) {
    const withExclude = buildArgs({ cwd: '/scratch', mode, webSearch: false, excludeTmp: true });
    const webIdx = withExclude.indexOf('tools.web_search=false');
    assert.ok(webIdx > -1, withExclude.join(' '));
    assert.deepEqual(
      withExclude.slice(webIdx + 1, webIdx + 5),
      ['-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true'],
      withExclude.join(' '),
    );
    // -C still follows right after the two overrides.
    const cIdx = withExclude.indexOf('-C');
    assert.equal(cIdx, webIdx + 5, withExclude.join(' '));
    assert.equal(withExclude[cIdx + 1], '/scratch');
  }
});

test('buildArgs: excludeTmp omitted (default false) and excludeTmp explicitly false both carry neither override', () => {
  for (const mode of ['workspace-write', 'read-only']) {
    const omitted = buildArgs({ cwd: '/scratch', mode, webSearch: true });
    const explicitFalse = buildArgs({ cwd: '/scratch', mode, webSearch: true, excludeTmp: false });
    for (const argv of [omitted, explicitFalse]) {
      assert.ok(!argv.includes('sandbox_workspace_write.exclude_slash_tmp=true'), argv.join(' '));
      assert.ok(!argv.includes('sandbox_workspace_write.exclude_tmpdir_env_var=true'), argv.join(' '));
      assert.ok(!argv.some((x) => /sandbox_workspace_write/.test(x)), argv.join(' '));
    }
  }
});

// --- runtime plumbing: a fake codex that logs its own argv ------------------

/**
 * A fake `codex` binary: reads stdin (ignored), writes the argv it received to
 * `argvLog`, optionally drops `image.png` in the -C dir, and answers with a
 * minimal valid JSONL turn so extractResult is happy either way.
 */
function makeArgvFake(dir, name, argvLog, { writeImage = false } = {}) {
  const fake = join(dir, name);
  writeFileSync(fake, [
    'import { writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{',
    '  const args=process.argv.slice(2);',
    `  writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args));`,
    '  const cIdx=args.indexOf("-C");',
    '  const cwd=cIdx>-1?args[cIdx+1]:process.cwd();',
    `  if (${writeImage ? 'true' : 'false'}) writeFileSync(join(cwd, "image.png"), "\x89PNG fake");`,
    '  const line=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");',
    '  line({type:"item.completed",item:{type:"agent_message",text:join(cwd,"image.png")}});',
    '  line({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}});',
    '});',
  ].join('\n'));
  return fake;
}

const wrapCodex = (env, fake) => createUnitRuntime(
  { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
  { env },
);

test('codex_image: the captured argv carries both overrides and -s workspace-write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fix7-image-'));
  const argvLog = join(dir, 'argv.json');
  const fake = makeArgvFake(dir, 'fake-image.mjs', argvLog, { writeImage: true });
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { codex: { timeoutS: 30 } } }));
  const r = await wrapCodex({ ...process.env, OMELETTE_HOME: dir, CODEX_BIN: process.execPath }, fake)
    .callTool('codex_image', { prompt: 'a small flat red circle' });
  assert.ok(!r.isError, r.text);

  const argv = JSON.parse(readFileSync(argvLog, 'utf8'));
  assert.equal(argv[argv.indexOf('-s') + 1], 'workspace-write');
  assert.ok(argv.includes('sandbox_workspace_write.exclude_slash_tmp=true'), argv.join(' '));
  assert.ok(argv.includes('sandbox_workspace_write.exclude_tmpdir_env_var=true'), argv.join(' '));
});

test('codex_image: the -C directory is a fresh directory under the OS temp dir, never the caller\'s cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fix7-image-cwd-'));
  const argvLog = join(dir, 'argv.json');
  const fake = makeArgvFake(dir, 'fake-image-cwd.mjs', argvLog, { writeImage: true });
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { codex: { timeoutS: 30 } } }));
  const r = await wrapCodex({ ...process.env, OMELETTE_HOME: dir, CODEX_BIN: process.execPath }, fake)
    .callTool('codex_image', { prompt: 'x' });
  assert.ok(!r.isError, r.text);

  const argv = JSON.parse(readFileSync(argvLog, 'utf8'));
  const cwd = argv[argv.indexOf('-C') + 1];
  assert.ok(cwd, argv.join(' '));
  assert.notEqual(realpathSync(cwd), realpathSync(process.cwd()));
  const realTmp = realpathSync(tmpdir());
  assert.ok(realpathSync(cwd).startsWith(realTmp), `${cwd} is not under ${realTmp}`);
});

test('codex_research: the captured argv carries neither override (ceiling closed, default read-only)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fix7-research-'));
  const argvLog = join(dir, 'argv.json');
  const fake = makeArgvFake(dir, 'fake-research.mjs', argvLog);
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { codex: { timeoutS: 30 } } }));
  const r = await wrapCodex({ ...process.env, OMELETTE_HOME: dir, CODEX_BIN: process.execPath }, fake)
    .callTool('codex_research', { prompt: 'hello' });
  assert.ok(!r.isError, r.text);

  const argv = JSON.parse(readFileSync(argvLog, 'utf8'));
  assert.equal(argv[argv.indexOf('-s') + 1], 'read-only');
  assert.ok(!argv.some((x) => /sandbox_workspace_write/.test(x)), argv.join(' '));
});

test('codex_code_review: the captured argv carries neither override — ceiling closed (read-only) and open with an explicit cwd (workspace-write)', async () => {
  // Ceiling closed: read-only regardless of requested mode.
  const dirClosed = mkdtempSync(join(tmpdir(), 'omelette-fix7-review-closed-'));
  const argvLogClosed = join(dirClosed, 'argv.json');
  const fakeClosed = makeArgvFake(dirClosed, 'fake-review-closed.mjs', argvLogClosed);
  writeFileSync(join(dirClosed, 'fleet.config.json'), JSON.stringify({ units: { codex: { mode: 'workspace-write', timeoutS: 30 } } }));
  const rClosed = await wrapCodex({ ...process.env, OMELETTE_HOME: dirClosed, CODEX_BIN: process.execPath }, fakeClosed)
    .callTool('codex_code_review', { prompt: 'look', cwd: dirClosed });
  assert.ok(!rClosed.isError, rClosed.text);
  const argvClosed = JSON.parse(readFileSync(argvLogClosed, 'utf8'));
  assert.equal(argvClosed[argvClosed.indexOf('-s') + 1], 'read-only');
  assert.ok(!argvClosed.some((x) => /sandbox_workspace_write/.test(x)), argvClosed.join(' '));

  // Ceiling open, mode workspace-write, explicit cwd: the review tool's own
  // wider mode, still with neither override.
  const dirOpen = mkdtempSync(join(tmpdir(), 'omelette-fix7-review-open-'));
  const argvLogOpen = join(dirOpen, 'argv.json');
  const fakeOpen = makeArgvFake(dirOpen, 'fake-review-open.mjs', argvLogOpen);
  writeFileSync(join(dirOpen, 'fleet.config.json'), JSON.stringify({ units: { codex: { mode: 'workspace-write', timeoutS: 30 } } }));
  const envOpen = { ...process.env, OMELETTE_HOME: dirOpen, OMELETTE_ALLOW_WRITE: 'codex', CODEX_BIN: process.execPath };
  const rOpen = await wrapCodex(envOpen, fakeOpen).callTool('codex_code_review', { prompt: 'look', cwd: dirOpen });
  assert.ok(!rOpen.isError, rOpen.text);
  const argvOpen = JSON.parse(readFileSync(argvLogOpen, 'utf8'));
  assert.equal(argvOpen[argvOpen.indexOf('-s') + 1], 'workspace-write');
  assert.ok(!argvOpen.some((x) => /sandbox_workspace_write/.test(x)), argvOpen.join(' '));
});
