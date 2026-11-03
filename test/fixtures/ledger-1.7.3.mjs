/**
 * omelette-fleet :: test/fixtures/ledger-1.7.3.mjs
 * A throwaway project for the 1.7.3 ledger tests: a real git repository on
 * `main` with one empty commit (or none, with `git: false`), an `.omelette/`
 * beside it, and the helpers the tests share. Never this checkout.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
export const GIT_SKIP = HAS_GIT ? false : 'git is not on PATH — these tests need a real repository';
const GIT_ID = ['-c', 'user.name=omelette test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];

/** The SessionStart print's first line since 1.8.0: the marker the mod strips, counted inside the 12 KB cap. */
export const PRINT_MARKER = '--- omelette-fleet · read before continuing ---\n';

/**
 * The SessionStart print's text as the tests read it: since 1.8.0 stdout is one
 * JSON document, `hookSpecificOutput.additionalContext` the text, led by the
 * marker line. Returns that text less the marker line, so the assertions on the
 * sections read as before; '' when nothing was printed; throws on any other shape.
 */
export function printed(stdout) {
  if (stdout === '') return '';
  const output = JSON.parse(stdout).hookSpecificOutput;
  const text = output.additionalContext;
  if (output.hookEventName !== 'SessionStart' || typeof text !== 'string' || !text.startsWith(PRINT_MARKER)) throw new Error(`not the 1.8.0 print: ${stdout.slice(0, 120)}`);
  return text.slice(PRINT_MARKER.length);
}

/** A ledger with the 1.7.3 header, then `lines`, ending in a newline. */
export const ledger = (branch, ...lines) => ['# ledger', `branch: ${branch}`, '', ...lines, ''].join('\n');

export function project({ git = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'omelette-ledger-')));
  mkdirSync(join(dir, '.omelette'));
  const run = (args) => {
    const r = spawnSync('git', [...GIT_ID, ...args], {
      cwd: dir, encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return (r.stdout || '').trim();
  };
  if (git) {
    run(['init', '-q']);
    run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    run(['commit', '-q', '--allow-empty', '-m', 'init']);
  }
  const write = (rel, text) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    return p;
  };
  const read = (rel) => readFileSync(join(dir, rel), 'utf8');
  /** Every path under the project but `.git`: a file's text, `dir`, or `symlink → <target>`. */
  const snapshot = () => {
    const out = {};
    const walk = (rel) => {
      for (const name of readdirSync(rel ? join(dir, rel) : dir).sort()) {
        if (!rel && name === '.git') continue;
        const r = rel ? `${rel}/${name}` : name;
        const st = lstatSync(join(dir, r));
        if (st.isSymbolicLink()) out[r] = `symlink → ${readlinkSync(join(dir, r))}`;
        else if (st.isDirectory()) { out[`${r}/`] = 'dir'; walk(r); }
        else out[r] = readFileSync(join(dir, r), 'utf8');
      }
    };
    walk('');
    return out;
  };
  return { dir, git: run, write, read, snapshot };
}
