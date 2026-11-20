// A fake `docker` for suite P's tests (scripts/eval-patch.mjs). It never runs a container: it logs every
// argv, keeps the images it was given, records what each `run` was staged with, and answers from markers
// in the staged change:
//   FAKE: does-not-apply     the apply step fails as `git apply` and `patch` would (exit 121);
//   FAKE: needs-fuzz         the change applies, by `patch`;
//   FAKE: fixes              the fail-to-pass step passes (without it, it fails: exit 1);
//   FAKE: breaks-neighbours  the pass-to-pass step fails;
//   FAKE: hangs              the fail-to-pass step never ends: the caller's timeout must kill it.
// `<state>/flip-f2p-at` holding N turns the Nth fail-to-pass step's result over: a flaky test.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = (state) => `
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const STATE = ${JSON.stringify(state)};
const at = (f) => path.join(STATE, f);
const argv = process.argv.slice(2);
fs.appendFileSync(at('log.jsonl'), JSON.stringify(argv) + '\\n');
const images = () => (fs.existsSync(at('images')) ? fs.readFileSync(at('images'), 'utf8').split('\\n').filter(Boolean) : []);
const idOf = (ref) => 'sha256:' + crypto.createHash('sha256').update(ref).digest('hex');
const find = (ref) => images().find((r) => r === ref || idOf(r) === ref);
function main() {
  const [cmd] = argv;
  if (cmd === 'image' && argv[1] === 'inspect') {
    const r = find(argv[argv.length - 1]);
    if (!r) { process.stderr.write('Error: No such image\\n'); return 1; }
    process.stdout.write(idOf(r) + '\\n');
    return 0;
  }
  if (cmd === 'pull') {
    if (fs.existsSync(at('no-pull'))) return 1;
    fs.appendFileSync(at('images'), argv[argv.length - 1] + '\\n');
    return 0;
  }
  if (cmd === 'build') { fs.appendFileSync(at('images'), argv[argv.indexOf('-t') + 1] + '\\n'); return 0; }
  if (cmd === 'kill') return 0;
  if (cmd !== 'run') return 1;
  const mount = argv[argv.indexOf('--mount') + 1] || '';
  const stage = (/source=([^,]+)/.exec(mount) || [])[1];
  const step = argv[argv.length - 1];
  if (!find(argv[argv.length - 3])) { process.stderr.write('Unable to find image\\n'); return 125; }
  const files = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r); else files.push(r);
    }
  };
  walk(stage, '');
  files.sort();
  const contents = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(stage, f), 'utf8')]));
  fs.appendFileSync(at('stages.jsonl'), JSON.stringify({ step, files, contents }) + '\\n');
  const change = contents['change.diff'] ?? null;
  if (step === 'f2p' && change && change.includes('FAKE: hangs')) { setTimeout(() => {}, 60000); return null; }
  if (step === 'apply') {
    if (change && change.includes('FAKE: does-not-apply')) { process.stderr.write('error: patch failed: invented.go:3\\n'); return 121; }
    process.stdout.write('applied-by ' + (!change ? 'none' : change.includes('FAKE: needs-fuzz') ? 'patch' : 'git') + '\\n');
    return 0;
  }
  if (step === 'f2p') {
    const n = (fs.existsSync(at('f2p-count')) ? Number(fs.readFileSync(at('f2p-count'), 'utf8')) : 0) + 1;
    fs.writeFileSync(at('f2p-count'), String(n));
    let pass = !!change && change.includes('FAKE: fixes');
    if (fs.existsSync(at('flip-f2p-at')) && Number(fs.readFileSync(at('flip-f2p-at'), 'utf8')) === n) pass = !pass;
    return pass ? 0 : 1;
  }
  if (step === 'p2p') return change && change.includes('FAKE: breaks-neighbours') ? 1 : 0;
  return 123;
}
const code = main();
if (code !== null) process.exit(code);
`;

/** A fake `docker` in `dir`: point OMELETTE_EVALS_DOCKER at `bin`. */
export function fakeDocker(dir) {
  const state = join(dir, 'fake-docker-state');
  mkdirSync(state, { recursive: true });
  const bin = join(dir, 'fake-docker');
  writeFileSync(bin, `#!${process.execPath}\n${SOURCE(state)}`);
  chmodSync(bin, 0o755);
  const jsonl = (f) => (existsSync(join(state, f)) ? readFileSync(join(state, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    bin,
    state,
    log: () => jsonl('log.jsonl'),
    runs: () => jsonl('log.jsonl').filter((a) => a[0] === 'run'),
    stages: () => jsonl('stages.jsonl'),
    addImage: (ref) => appendFileSync(join(state, 'images'), `${ref}\n`),
    flipF2pAt: (n) => writeFileSync(join(state, 'flip-f2p-at'), String(n)),
    noPull: () => writeFileSync(join(state, 'no-pull'), ''),
  };
}
