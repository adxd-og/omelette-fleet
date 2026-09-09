/**
 * omelette-fleet :: test/tester-0.3.5-model-window-review.test.mjs
 *
 * Independent tester coverage for the 0.3.5 diff actually present in the
 * working tree: §1 (a `[1m]` model id is a 1 000 000-token ceiling) and §5
 * (`readClientSetting` names an unreadable file) — read together, on the
 * `doctor` side, through `resolveContextWindow`.
 *
 * The implementer's own new tests in test/cli.test.mjs cover every SOURCE of
 * the ceiling chain in isolation, and one case where a broken settings file
 * sits ahead of a value `autoCompactWindow` answers immediately (so the
 * `model` scan inside `resolveContextWindow` never runs at all). What is not
 * covered anywhere: the path where `autoCompactWindow` answers NOTHING
 * (absent from every file), so the function falls through to the `model[1m]`
 * scan, and a settings file broken enough to trip BOTH of those internal
 * `readClientSetting` calls — the ceiling has to fall further still, and the
 * two calls' `unreadable` lists have to merge into exactly one line, not two.
 * That merge (`mergeUnreadable(setting.unreadable, model.unreadable)` at the
 * call site in `resolveContextWindow`) is new code in this diff and untested
 * by the implementer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

/** A fresh fleet home per test; HOME follows it, exactly like test/cli.test.mjs's own `home()`. */
function home() {
  return mkdtempSync(join(tmpdir(), 'omelette-0.3.5-model-'));
}

/** `rules`, run inside a project dir — same shape as cli.test.mjs's `rulesIn`. */
const rulesIn = (proj, dir, args = []) => spawnSync(process.execPath, [BIN, 'rules', ...args], {
  cwd: proj, encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
});

/** `doctor`, run inside a project dir — same shape as cli.test.mjs's `doctorIn2`. */
const doctorIn = (proj, dir, env = {}) => spawnSync(process.execPath, [BIN, 'doctor'], {
  cwd: proj, encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
}).stdout;

/** Every `settings: … unreadable` line doctor printed, in order, label column stripped. */
const settingsLines = (out) => out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('settings: '));

test('doctor: no autoCompactWindow anywhere, no [1m] model anywhere, and a broken user settings.local.json — the ceiling falls all the way to the 200000 default, and the file is named exactly ONCE though both the autoCompactWindow scan and the model scan inside resolveContextWindow open it', () => {
  const dir = home();
  const proj = join(dir, 'proj');
  mkdirSync(proj, { recursive: true });
  assert.equal(rulesIn(proj, dir, ['--hooks']).status, 0);
  mkdirSync(join(dir, '.claude'), { recursive: true });

  // Malformed JSON (a trailing comma): readClientSetting's JSON.parse branch.
  // The file the client reads FIRST (local before shared).
  writeFileSync(join(dir, '.claude', 'settings.local.json'), '{ "autoCompactWindow": "500k", }');
  // Parses fine, is an object, and says nothing about either key this chain
  // cares about — readable, and simply silent.
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: [] } }));

  const out = doctorIn(proj, dir);

  // Neither scan found a value anywhere: default, not a stale echo of the
  // "500k" that was in the broken file.
  assert.match(out, /^handoff {7}nudge at 90% of 200000 \(default\)/m, out);

  // ONE line — not one per internal scan that tripped over the same path.
  assert.deepEqual(
    settingsLines(out),
    [`settings: ${join(dir, '.claude', 'settings.local.json')} unreadable — its values were not consulted`],
    out,
  );
});

test('doctor: model[1m] resolves from the SECOND user settings file while the first is unreadable — the ceiling is not blocked by it, but the file is still named once (not twice, once per internal scan)', () => {
  const dir = home();
  const proj = join(dir, 'proj');
  mkdirSync(proj, { recursive: true });
  assert.equal(rulesIn(proj, dir, ['--hooks']).status, 0);
  mkdirSync(join(dir, '.claude'), { recursive: true });

  // Valid JSON whose TOP LEVEL is not an object — the other branch of
  // readClientSetting's unreadable rule (`!isObj(parsed)`), not a parse
  // failure. Read first, has nothing to say about either key, and is
  // "unreadable" by the spec's second clause: "parses to a non-object".
  writeFileSync(join(dir, '.claude', 'settings.local.json'), '[1, 2]');
  // No autoCompactWindow anywhere, so resolveContextWindow falls through to
  // the model scan, which finds this.
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-5[1m]' }));

  const out = doctorIn(proj, dir);

  assert.match(out, /^handoff {7}nudge at 90% of 1000000 \(model\[1m\]\)/m, out);
  // The raw model id is never printed anywhere in the report.
  assert.equal(out.includes('claude-opus-5[1m]'), false, out);

  assert.deepEqual(
    settingsLines(out),
    [`settings: ${join(dir, '.claude', 'settings.local.json')} unreadable — its values were not consulted`],
    out,
  );
});
