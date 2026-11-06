// 1.9.0 Task 1 (plan docs/superpowers/plans/2026-11-06-1.9.0-mistral-unit.md;
// spec docs/superpowers/specs/2026-11-06-mistral-unit-design.md §1 Environment,
// §2): the Mistral catalog and the two Vibe homes the unit renders under the
// fleet home. HOME and OMELETTE_HOME point at temp dirs: the operator's ~/.vibe
// is never read or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCatalog } from '../core/catalog.mjs';
import { EFFORTS, GUIDE, MISTRAL_MODELS } from '../units/mistral/models.js';
import { ensureHome, renderVibeConfig, renderWrapper, resolveAlias } from '../units/mistral/home.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const POLICY = [
  'enable_telemetry = false',
  'enable_update_checks = false',
  'enable_auto_update = false',
  'enable_subagents = false',
  'enable_mcp = false',
  'enable_connectors = false',
  'outside_workdir = "deny"',
  'show_greeting = false',
];
/**
 * The probe profile (2026-11-06, probes 4 and 7), verbatim but for the six read-denies
 * T3 round 2 appended to its list (~/.gnupg … ~/.git-credentials); FLEET_DENY follows it.
 */
const PROBE_SB = [
  "(version 1)",
  "; Seatbelt profile for the repro sandbox probe: everything the model runs goes",
  "; through this. Allow by default, then take away writes outside the clone and",
  "; the temp dir, all network, and reads of the operator's secret dirs.",
  "(allow default)",
  "(deny network*)",
  "(deny file-write*)",
  "(allow file-write*",
  "  (subpath (param \"CLONE\"))",
  "  (subpath (param \"TMP\"))",
  "  (subpath \"/private/var/folders\")",
  "  (literal \"/dev/null\")",
  "  (regex #\"^/dev/tty\")",
  "  (regex #\"^/dev/fd/\"))",
  "(deny file-read*",
  "  (subpath (string-append (param \"HOME\") \"/.ssh\"))",
  "  (subpath (string-append (param \"HOME\") \"/.aws\"))",
  "  (subpath (string-append (param \"HOME\") \"/.omelette\"))",
  "  (subpath (string-append (param \"HOME\") \"/.vibe\"))",
  "  (subpath (string-append (param \"HOME\") \"/.config\"))",
  "  (subpath (string-append (param \"HOME\") \"/.gnupg\"))",
  "  (subpath (string-append (param \"HOME\") \"/.netrc\"))",
  "  (subpath (string-append (param \"HOME\") \"/.kube\"))",
  "  (subpath (string-append (param \"HOME\") \"/.docker\"))",
  "  (subpath (string-append (param \"HOME\") \"/.npmrc\"))",
  "  (subpath (string-append (param \"HOME\") \"/.git-credentials\")))",
].join('\n') + '\n';
const FLEET_DENY = '(deny file-read* (subpath (param "FLEET")))\n';
/** 1.9.0 T3 (ruling 2026-11-06): no hand-off to a process outside the profile; the run's OUT dir is Vibe's. */
const T3_BLOCK = [
  '; a command must not hand work to a process outside this profile',
  '(deny appleevent-send)',
  '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/bin/launchctl") (literal "/usr/bin/automator") (literal "/usr/bin/security") (literal "/usr/bin/pbpaste") (literal "/usr/bin/pbcopy"))',
  '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.lsd.mapdb") (global-name "com.apple.lsd.modifydb"))',
  "; a command signals only processes of its own sandbox: not Vibe, not the operator's other processes",
  '(deny signal)',
  '(allow signal (target same-sandbox))',
  "; the run's own output dir (export.json, session/meta.json, prompt.md) is Vibe's, not the model's",
  '(deny file-read* (subpath (param "OUT")))',
  '(deny file-write* (subpath (param "OUT")))',
].join('\n') + '\n';
/** T3 round 2: the fleet's temp dirs and every run denied, the walk down to the run kept, the run's clone and tmp re-allowed LAST. */
const RUNS_BLOCK = [
  "; the fleet's other temp dirs (every omelette-* under the OS temp root, another unit's included) are no command's either",
  '(deny file-read* (regex (string-append "^" (param "TMPROOT") "/omelette-")))',
  '(deny file-write* (regex (string-append "^" (param "TMPROOT") "/omelette-")))',
  "; every run lives under RUNS: a command sees and writes its own clone and tmp (re-allowed last), never a sibling run's clone, tmp or out",
  '(deny file-read* (subpath (param "RUNS")))',
  '(deny file-write* (subpath (param "RUNS")))',
  "; the path down to the run's own clone and tmp stays walkable (node and git lstat every component): RUNS and this run's dir, metadata only; listing stays denied, a sibling run dir is not even stat-able",
  '(allow file-read-metadata (literal (param "RUNS")) (literal (param "RUN")))',
  '(allow file-read* (subpath (param "CLONE")) (subpath (param "TMP")))',
  '(allow file-write* (subpath (param "CLONE")) (subpath (param "TMP")))',
  "; no immutable or append-only flag in the run's clone or tmp: the adapter must be able to remove the run",
  '(deny file-write-flags (subpath (param "CLONE")) (subpath (param "TMP")))',
].join('\n') + '\n';

test('catalog head is mistral-large-4-0-3 and resolveAlias moves within a family', () => {
  const catalog = makeCatalog({ models: MISTRAL_MODELS, efforts: EFFORTS, guide: GUIDE });
  assert.deepEqual(catalog.ids, [
    'mistral-large-4-0-3', 'mistral-large-4-0-3-medium', 'mistral-large-4-0-3-low',
    'zai-glm-5-3-flash', 'zai-glm-5-3-flash-low', 'zai-glm-5-3-flash-max',
    'glm-5-3', 'glm-5-3-low', 'glm-5-3-max',
    'mistral-medium-3.5', 'mistral-medium-3.5-off',
  ]);
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'max']);
  assert.equal(resolveAlias('mistral-large-4-0-3', 'low'), 'mistral-large-4-0-3-low');
  assert.equal(resolveAlias('mistral-large-4-0-3-low', 'high'), 'mistral-large-4-0-3');
  assert.equal(resolveAlias('glm-5-3', 'medium'), 'glm-5-3');
});

test('renderVibeConfig carries the policy block, every alias and the wrapper path', () => {
  const home = '/fleet-home';
  const text = renderVibeConfig({ models: MISTRAL_MODELS, profile: 'review', home, version: '9.9.9' });
  const lines = text.split('\n');
  assert.equal(lines[0], '# omelette-fleet mistral/review home v9.9.9 — rendered from units/mistral/models.js; edits are overwritten');
  assert.ok(lines.includes('active_model = "mistral-large-4-0-3"'));
  for (const p of POLICY) assert.ok(lines.includes(p), p);
  for (const m of MISTRAL_MODELS) assert.ok(text.includes(`alias = "${m.id}"`), m.id);
  const entry = (alias) => lines.find((l) => l.includes(`alias = "${alias}"`));
  assert.match(entry('zai-glm-5-3-flash-max'), /thinking = "max"/);
  assert.doesNotMatch(entry('mistral-medium-3.5-off'), /thinking =/);
  // Vibe's ModelConfig prices default to 0.0: without them a paid row's
  // `--max-price` never trips and its cost_usd reads $0.
  assert.match(entry('glm-5-3'), /input_price = 1\.4, output_price = 4\.4/);
  // The same defaults would run it at 0.2; the replay ran at the server catalog's 1.0.
  assert.match(entry('mistral-large-4-0-3'), /temperature = 1\.0/);
  assert.ok(lines.includes('[tools.bash]'));
  assert.ok(lines.includes(`shell = "${home}/vibe/review/shell.sh"`));
  // 1.9.0 T2 round 3: Vibe's session log is off in both homes — on, a run left its
  // prompt and the files the model read under <home>/logs/session/unified/.
  for (const profile of ['review', 'repro']) {
    const l = renderVibeConfig({ models: MISTRAL_MODELS, profile, home, version: '9.9.9' }).split('\n');
    const at = l.indexOf('[session_logging]');
    assert.ok(at > 0, `${profile}: [session_logging] rendered`);
    assert.equal(l[at + 1], 'enabled = false', `${profile}: logging off, inside its table`);
    assert.ok(at < l.indexOf('[tools.bash]'), `${profile}: before [tools.bash]`);
  }
});

test('ensureHome renders wx, re-renders on change, never follows a symlink', () => {
  const saved = { HOME: process.env.HOME, OMELETTE_HOME: process.env.OMELETTE_HOME };
  const home = mkdtempSync(join(tmpdir(), 'omelette-mistral-home-'));
  const fleet = join(home, '.omelette');
  process.env.HOME = home;
  process.env.OMELETTE_HOME = fleet;
  try {
    const first = ensureHome({ profile: 'review', models: MISTRAL_MODELS, version: '9.9.9' });
    assert.deepEqual(first, { dir: join(fleet, 'vibe', 'review'), rendered: true });
    assert.equal(readFileSync(join(first.dir, 'config.toml'), 'utf8'), renderVibeConfig({ models: MISTRAL_MODELS, profile: 'review', home: fleet, version: '9.9.9' }));
    assert.equal(readFileSync(join(first.dir, 'shell.sh'), 'utf8'), renderWrapper({ profile: 'review', home: fleet }));
    assert.equal(ensureHome({ profile: 'review', models: MISTRAL_MODELS, version: '9.9.9' }).rendered, false);

    const repro = ensureHome({ home: fleet, profile: 'repro', models: MISTRAL_MODELS, version: '9.9.9' });
    assert.ok(readFileSync(join(repro.dir, 'repro.sb')).equals(readFileSync(join(ROOT, 'units', 'mistral', 'repro.sb'))));
    assert.equal(readFileSync(join(ROOT, 'units', 'mistral', 'repro.sb'), 'utf8'), PROBE_SB + FLEET_DENY + T3_BLOCK + RUNS_BLOCK);

    const changed = MISTRAL_MODELS.map((m, i) => (i === 1 ? { ...m, id: 'mistral-large-4-0-3-renamed' } : m));
    assert.equal(ensureHome({ home: fleet, profile: 'review', models: changed, version: '9.9.9' }).rendered, true);
    assert.match(readFileSync(join(first.dir, 'config.toml'), 'utf8'), /alias = "mistral-large-4-0-3-renamed"/);

    // A regular file left at the temporary name (a run that died before its rename, its pid come round again) is removed.
    const tmp = join(first.dir, `config.toml.tmp-${process.pid}`);
    writeFileSync(tmp, 'leftover');
    assert.equal(ensureHome({ home: fleet, profile: 'review', models: MISTRAL_MODELS, version: '9.9.9' }).rendered, true);
    assert.equal(existsSync(tmp), false);
    assert.doesNotMatch(readFileSync(join(first.dir, 'config.toml'), 'utf8'), /renamed/);

    // wx: a link planted at the temporary name fails the write instead of being followed.
    const victim = join(home, 'victim');
    writeFileSync(victim, 'untouched');
    symlinkSync(victim, tmp);
    assert.throws(() => ensureHome({ home: fleet, profile: 'review', models: changed, version: '9.9.9' }), (e) => e.message.includes(tmp));
    assert.equal(readFileSync(victim, 'utf8'), 'untouched');
    unlinkSync(tmp);

    // The right bytes under a looser mode get the mode back: one log line, nothing rendered.
    const shell = join(first.dir, 'shell.sh');
    chmodSync(shell, 0o755);
    const logged = [];
    assert.equal(ensureHome({ home: fleet, profile: 'review', models: MISTRAL_MODELS, version: '9.9.9', log: (l) => logged.push(l) }).rendered, false);
    assert.equal(statSync(shell).mode & 0o777, 0o700);
    assert.equal(logged.length, 1);

    // A symlink at one of the names, at the profile dir or at <home>/vibe is refused, naming the path.
    unlinkSync(shell);
    symlinkSync(victim, shell);
    assert.throws(() => ensureHome({ home: fleet, profile: 'review', models: MISTRAL_MODELS, version: '9.9.9' }), (e) => e.message.includes(shell));
    assert.equal(readFileSync(victim, 'utf8'), 'untouched');

    const elsewhere = mkdtempSync(join(tmpdir(), 'omelette-mistral-elsewhere-'));
    renameSync(first.dir, join(elsewhere, 'moved'));
    symlinkSync(elsewhere, first.dir);
    assert.throws(() => ensureHome({ home: fleet, profile: 'review', models: MISTRAL_MODELS, version: '9.9.9' }), (e) => e.message.includes(first.dir));

    const other = mkdtempSync(join(tmpdir(), 'omelette-mistral-fleet-'));
    mkdirSync(join(other, 'elsewhere'));
    symlinkSync(join(other, 'elsewhere'), join(other, 'vibe'));
    assert.throws(() => ensureHome({ home: other, profile: 'review', models: MISTRAL_MODELS, version: '9.9.9' }), (e) => e.message.includes(join(other, 'vibe')));
    assert.equal(existsSync(join(other, 'elsewhere', 'review')), false);

    assert.equal(existsSync(join(home, '.vibe')), false);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('ensureHome leaves rendered.json with the version when it renders; a call that renders nothing keeps its time', () => {
  const fleet = mkdtempSync(join(tmpdir(), 'omelette-mistral-sidecar-'));
  const first = ensureHome({ home: fleet, profile: 'review', models: MISTRAL_MODELS, version: '9.9.9' });
  const sidecar = join(first.dir, 'rendered.json');
  const written = JSON.parse(readFileSync(sidecar, 'utf8'));
  assert.equal(written.version, '9.9.9');
  assert.ok(!Number.isNaN(Date.parse(written.at)));
  assert.equal(statSync(sidecar).mode & 0o777, 0o600);
  assert.equal(ensureHome({ home: fleet, profile: 'review', models: MISTRAL_MODELS, version: '9.9.9' }).rendered, false);
  assert.equal(JSON.parse(readFileSync(sidecar, 'utf8')).at, written.at);
});

test('the wrapper answers the login-env probe with env -0 and no login shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-mistral-wrap-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  // A login shell would source these and export the planted value.
  for (const f of ['.bash_profile', '.profile']) writeFileSync(join(home, f), 'export ZZZ_PLANTED=planted\n');
  const wrapper = join(dir, 'shell.sh');
  writeFileSync(wrapper, renderWrapper({ profile: 'review', home: join(dir, 'fleet') }));
  chmodSync(wrapper, 0o700);
  const env = { PATH: '/usr/bin:/bin', OMELETTE_T: '1', HOME: home };
  // Vibe keeps what follows its marker: the marker first, then the NUL-separated env.
  const marker = 'mistralai-vibe-login-env-0f3a9c1d2b4e5a6f';
  const out = execFileSync(wrapper, ['-lc', `printf '%s' ${marker}; printf '%s' ${marker}; exec env -0`], { env }).toString();
  assert.ok(out.startsWith(marker));
  const dump = out.slice(marker.length);
  assert.ok(dump.endsWith('\0'));
  assert.ok(dump.split('\0').includes('OMELETTE_T=1'));
  assert.ok(!out.includes('ZDOTDIR'));
  assert.ok(!out.includes('ZZZ_PLANTED'));
  // Review has no shell by policy: a command that reaches the wrapper is refused, never run.
  const refused = spawnSync(wrapper, ['-c', 'echo hi'], { env });
  assert.equal(refused.status, 126);
  assert.equal(refused.stdout.toString(), '');
  assert.match(refused.stderr.toString(), /review profile has no shell/);
});

test('the repro wrapper stops before sandbox-exec when HOME is unset: an empty HOME would turn the ~/.ssh read-denies into /.ssh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-mistral-nohome-'));
  const [clone, tmpd, fleet] = ['clone', 'tmp', 'fleet'].map((n) => join(dir, n));
  for (const d of [clone, tmpd, fleet]) mkdirSync(d);
  const wrapper = join(dir, 'shell.sh');
  writeFileSync(wrapper, renderWrapper({ profile: 'repro', home: fleet }));
  chmodSync(wrapper, 0o700);
  const env = { PATH: '/usr/bin:/bin', OMELETTE_REPRO_CLONE: clone, OMELETTE_REPRO_TMP: tmpd, OMELETTE_FLEET_HOME: fleet };
  const run = spawnSync(wrapper, ['-c', 'touch "$OMELETTE_REPRO_CLONE/ran"'], { env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr.toString(), /HOME/);
  assert.equal(existsSync(join(clone, 'ran')), false);
});

// 1.9.0 T3 fix round (Q7): CLONE and TMP are required like HOME — an empty one would hand the profile `(subpath "")`;
// round 2: RUNS and TMPROOT likewise, an empty one would deny nothing.
test('the repro wrapper stops before sandbox-exec when OMELETTE_REPRO_CLONE, _TMP, _RUNS, _RUN or _TMPROOT is unset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-mistral-noclone-'));
  const [clone, tmpd, fleet, out, home] = ['clone', 'tmp', 'fleet', 'out', 'home'].map((n) => join(dir, n));
  for (const d of [clone, tmpd, fleet, out, home]) mkdirSync(d);
  const wrapper = join(dir, 'shell.sh');
  writeFileSync(wrapper, renderWrapper({ profile: 'repro', home: fleet }));
  chmodSync(wrapper, 0o700);
  const full = {
    PATH: '/usr/bin:/bin', HOME: home, OMELETTE_REPRO_CLONE: clone, OMELETTE_REPRO_TMP: tmpd, OMELETTE_FLEET_HOME: fleet, OMELETTE_REPRO_OUT: out,
    OMELETTE_REPRO_RUNS: dir, OMELETTE_REPRO_RUN: dir, OMELETTE_REPRO_TMPROOT: dir, T_MARK: join(dir, 'ran'),
  };
  for (const name of ['OMELETTE_REPRO_CLONE', 'OMELETTE_REPRO_TMP', 'OMELETTE_REPRO_RUNS', 'OMELETTE_REPRO_RUN', 'OMELETTE_REPRO_TMPROOT']) {
    const env = { ...full };
    delete env[name];
    const run = spawnSync(wrapper, ['-c', 'touch "$T_MARK"'], { env });
    assert.notEqual(run.status, 0, name);
    assert.match(run.stderr.toString(), new RegExp(name), name);
    assert.equal(existsSync(join(dir, 'ran')), false, `${name}: nothing executed`);
  }
});

test('the repro profile read-denies the fleet home wherever OMELETTE_HOME put it; the clone stays readable', { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') }, () => {
  // sandbox-exec cannot nest: inside a sandbox even an allow-everything profile fails, and only then is this skipped.
  if (spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status !== 0) return;
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'omelette-mistral-fleetdeny-')));
  const fleet = join(base, 'relocated-fleet');
  const { dir } = ensureHome({ home: fleet, profile: 'repro' });
  const [clone, tmpd, home, out] = ['clone', 'tmp', 'home', 'out'].map((n) => join(base, n));
  for (const d of [clone, tmpd, home, out]) mkdirSync(d);
  writeFileSync(join(fleet, 'fleet.config.json'), 'fleet secret\n');
  writeFileSync(join(clone, 'readme'), 'in the clone\n');
  const env = {
    PATH: '/usr/bin:/bin', HOME: home, OMELETTE_REPRO_CLONE: clone, OMELETTE_REPRO_TMP: tmpd, OMELETTE_FLEET_HOME: fleet, OMELETTE_REPRO_OUT: out,
    OMELETTE_REPRO_RUNS: join(base, 'runs'), OMELETTE_REPRO_RUN: base, OMELETTE_REPRO_TMPROOT: realpathSync(tmpdir()),
  };
  const run = (cmd) => spawnSync(join(dir, 'shell.sh'), ['-c', cmd], { env });
  const denied = run('cat "$OMELETTE_FLEET_HOME/fleet.config.json"');
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr.toString(), /Operation not permitted/);
  assert.doesNotMatch(denied.stdout.toString(), /fleet secret/);
  const allowed = run('cat "$OMELETTE_REPRO_CLONE/readme"');
  assert.equal(allowed.status, 0, allowed.stderr.toString());
  assert.equal(allowed.stdout.toString(), 'in the clone\n');
});
