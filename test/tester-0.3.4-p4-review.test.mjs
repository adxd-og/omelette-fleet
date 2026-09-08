/**
 * omelette-fleet :: test/tester-0.3.4-p4-review.test.mjs
 *
 * Independent tester pass on the uncommitted working-tree diff on branch
 * feat/0.3.4 (base 750d7d6, which already carries packages 1/2/3 committed).
 * The diff under test here is narrow: `hooks/omelette-guard.mjs` gains
 *
 *   - a rewritten `unquote()` that strips quote characters WHEREVER in a
 *     token they start, applied unconditionally (rather than only when the
 *     tokenizer's own `quoted` flag says the token opened with one) — fixing
 *     `git rebase --ex"ec" --abort main`, which the guard used to wave
 *     through while real git ran the rebase (`--exec`'s value became
 *     `--abort`);
 *   - `REBASE_ATTACHED_SHORT` (`-S`/`--gpg-sign`, whose key-id is optional
 *     and attached-only) ending a short-option cluster scan without
 *     consuming the next word, fixing `git rebase -SABC -h`, which the guard
 *     used to refuse (reading the trailing `C` of the key as `-C`, a real
 *     value-taking flag, and swallowing `-h` as its value);
 *   - `writeState()` looping over `writeSync` to the last byte before the
 *     rename, rather than trusting a single call to have taken everything.
 *
 * The implementer's own tests (test/hooks.test.mjs, test/hooks-handoff.test.mjs)
 * already cover, directly, on the exact mechanisms above:
 *   - quoting that starts mid-token, for a handful of long-option spellings
 *     (`--ex"ec"`, `--'exec'`, `--exec""`, `--on"to"`) and ONE short-option
 *     form, a cluster of exactly one letter (`-"x"`);
 *   - `-S` ending a cluster scan, for `-SABC`, `-Sx` and `-qS`, each with a
 *     recovery flag immediately behind it;
 *   - `writeState`'s observable contract — a 64-entry, ~130 KB map lands
 *     whole (parses, round-trips, no `.tmp` left over), and a directory that
 *     cannot be written yields silence and no half-written temporary file.
 *
 * Left uncovered, and covered below instead:
 *   - mid-token quoting inside a short-option cluster of MORE than one
 *     letter (`-q"x"`), where the quote characters shift the "is this letter
 *     last in the cluster" arithmetic that decides whether the NEXT WORD is
 *     consumed as a value — the implementer's own test only exercises the
 *     degenerate one-letter case, where that arithmetic can't actually go
 *     wrong on its own (verified against a real git binary below: the old
 *     `unquote` logic would have left `--abort` behind `-q"x"` unconsumed and
 *     readable, exactly the bug 2b was meant to close, one cluster letter
 *     over from the case that is tested);
 *   - `REBASE_ATTACHED_SHORT` and the mid-token-quote fix INTERACTING in one
 *     command (`-S"ABC"` — an attached, quoted gpg key) — each is tested
 *     alone, never together;
 *   - the bare form of the `-S` fix, no attached characters at all
 *     (`-S --abort` / `-S -h`) — the simplest instance of the flag the spec's
 *     own code comments quote as the motivating example, never fired;
 *   - a value that carries a DIFFERENT quote character nested inside the one
 *     that opened it (`"it's"` — the guard's own doc comment gives this
 *     exact example for what `unquote` must leave alone) sitting in an
 *     option's value position, to confirm the rewritten `unquote` does not
 *     let a stray quote character inside the value make `--exec`'s skip
 *     mis-fire.
 *
 * Two commands below (`-q"x" --abort master` and `--ex"ec" --abort master`)
 * are cross-checked against the system git binary in a throwaway repository,
 * the same way the implementer's own 2b regression test does, because a
 * classifier fix is only as good as the real command it is modelled on.
 *
 * Does not edit the implementation or the implementer's own test files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

const REFUSAL = (agent) => `${agent} never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead`;

/** The guard exactly as `rules --hooks` writes it, in a throwaway directory. */
function guard() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-p4-guard-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3'));
  return { dir, path };
}

/** One PreToolUse invocation: the event on stdin, the answer as code/stderr. */
function fire(path, command, agent = 'omelette-coder') {
  const input = JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: agent,
    tool_input: { command },
  });
  const r = spawnSync(process.execPath, [path], { input, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: (r.stderr || '').trim() };
}

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/** A throwaway repository with two branches that have each moved on by a commit, like the implementer's own 2b/2c fixture. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-p4-repo-'));
  const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 'a@b.c']);
  run(['config', 'user.name', 'a']);
  run(['commit', '-q', '--allow-empty', '-m', 'init']);
  run(['commit', '-q', '--allow-empty', '-m', 'second']); // master moves on
  run(['checkout', '-q', '-b', 'feature']);
  run(['commit', '-q', '--allow-empty', '-m', 'third']); // feature moves on too
  return { dir, run };
}

test('PreToolUse: mid-token quoting inside a MULTI-letter short cluster still hides the value skip, not just a one-letter cluster', () => {
  const g = guard();
  for (const command of [
    // `-q"x"` reaches git as `-qx`: `-q` is a flag on its own, `-x` is last in
    // the cluster and takes the NEXT WORD as its value — `--abort` — exactly
    // as `-"x"` alone does. The one-letter case is the implementer's own
    // test; this is one cluster letter over from it.
    'git rebase -q"x" --abort main',
    "git rebase -q'x' --abort main",
    // The same shape, but the quoted letter is not the LAST one in the
    // cluster: `-x"q"` unquotes to `-xq`, so `-x`'s value is the ATTACHED
    // `q`, never a separate word, and `--abort` stays a bare, readable token.
    // A quote character shifting a letter's position in the cluster must not
    // turn an attached value into a separate one, or the reverse.
  ]) {
    const r = fire(g.path, command);
    assert.equal(r.code, 2, `${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err, REFUSAL('omelette-coder'));
  }

  for (const command of [
    // A quoted letter that matches nothing in either rebase set is a no-op
    // wherever it sits in the cluster — over-blocking this would cost a
    // legitimate rebase for no reason.
    'git rebase -q"p" --abort main',
    // The value-taking letter attached (not last) still keeps its value
    // in-token; `--abort` is a separate, bare, readable word.
    'git rebase -x"q" --abort main',
  ]) {
    const r = fire(g.path, command);
    assert.equal(r.code, 0, `${command} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
});

test('PreToolUse: `-S` ends the cluster scan even with its key QUOTED, and the bare form with no key at all', () => {
  const g = guard();
  for (const command of [
    // The attached-only fix and the mid-token-quote fix, together: `-S"ABC"`
    // reaches git as `-SABC`, and the trailing `C` must still not be read as
    // the value-taking `-C`.
    'git rebase -S"ABC" -h',
    'git rebase -S"ABC" --abort',
    // The simplest form the spec's own code comment quotes as the bug: `-S`
    // with nothing attached at all, immediately followed by a recovery flag.
    'git rebase -S --abort',
    'git rebase -S -h',
    'git rebase -S --quit',
  ]) {
    const r = fire(g.path, command);
    assert.equal(r.code, 0, `${command} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
});

test('PreToolUse: a nested quote INSIDE an option value ("it\'s …") does not upset the --exec value skip', () => {
  const g = guard();
  for (const command of [
    // The guard's own doc comment gives exactly this example for what
    // `unquote` must leave alone: a `\'` inside a `"…"` span is a literal
    // character, not a second quote. The value stays data, and the bare
    // `--abort` behind it is real recovery.
    "git rebase --exec \"it's a test\" --abort",
    "git rebase -x \"it's a test\" --abort",
  ]) {
    const r = fire(g.path, command);
    assert.equal(r.code, 0, `${command} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
});

test('PreToolUse: quoting that starts mid-token composes with -S, the tester role, and does not over-block an unrelated cluster', () => {
  const g = guard();
  // Same mechanism, fired at the tester role too — 2a and this fix compose.
  const r = fire(g.path, 'git rebase -q"x" --abort main', 'omelette-tester');
  assert.equal(r.code, 2);
  assert.equal(r.err, REFUSAL('omelette-tester'));
});

test('cross-check against a real git binary: -q"x" --abort ACTUALLY rebases (a write), --ex"ec" --abort does not (git refuses the option)',
  { skip: !gitAvailable && 'git not available' }, () => {
    const g = guard();

    // git treats `-q"x"` as `-qx`: `-q` alone, then `-x`'s value is the next
    // word, `--abort` — an exec rebase whose command is literally "--abort".
    // That starts a rebase (a write) even though the exec command itself
    // then fails to run.
    {
      const r1 = repo();
      // spawnSync with an argv array never goes through a shell, so the
      // fixture passes git the exact single argv token a shell would hand it
      // for `-q"x"` — `-qx` — rather than re-deriving shell quoting here.
      const out = r1.run(['rebase', '-qx', '--abort', 'master']);
      assert.match(out.stderr + out.stdout, /Executing: --abort|execution failed/, `expected git to attempt exec --abort, got: ${JSON.stringify(out)}`);
      // It is mid-rebase: HEAD moved to detached, a rebase-merge dir exists.
      const status = r1.run(['status', '--short', '--branch']).stdout;
      assert.match(status, /no branch/, 'a write was in progress');
      r1.run(['rebase', '--abort']); // clean up the mid-rebase state
      const guardResult = fire(g.path, 'git rebase -q"x" --abort master');
      assert.equal(guardResult.code, 2, 'the guard must refuse what git actually writes');
    }

    // git rejects `--ex"ec"` outright — it does not match `--exec` once the
    // shell hands it over with the embedded quote characters literal — so
    // nothing is ever written, and the guard passing this command is correct.
    {
      const r2 = repo();
      const out = r2.run(['rebase', '--ex"ec"', '--abort', 'master']);
      assert.match(out.stderr, /unknown option/, `expected git to reject the option, got: ${JSON.stringify(out)}`);
      assert.equal(out.status, 129);
      const guardResult = fire(g.path, 'git rebase --ex"ec" --abort master');
      assert.equal(guardResult.code, 2, 'the guard blocks this one regardless, on the safe side, since the token carries a quote character');
    }
  });
