{{marker}}
/**
 * omelette-fleet :: the guard hook, one script for all five events.
 *
 * WIRED BY THE OPERATOR, NEVER BY US. `omelette-fleet rules --hooks` writes this
 * file and PRINTS the settings.json snippet that calls it; Claude Code's
 * settings.json is read by this package and written by nobody but the operator.
 *
 * PreToolUse (matcher Bash) — the git guard on the two sub-agent roles this
 * package ships. The operating model says "coder sub-agents never commit" and
 * asks the same of the tester, which reports what it saw rather than moving the
 * tree; a settings-level hook is what MAKES both true: the stdin event carries
 * `agent_type` for a sub-agent and nothing for the main thread, so the block
 * lands on omelette-coder and omelette-tester and on nothing else. Exit 2 is
 * what stops the call, and the reason it hands back names the agent it caught.
 *
 * PreCompact — the ledger's re-read marker. A compaction is where a plan loses
 * its context, so every `.omelette/ledger-*.md` gets a line saying it must be
 * re-read, and the handoff reminder goes to stdout for the harness to pass on if
 * it does.
 *
 * SessionStart (source `compact`) — the other half, and the half that is
 * PROMISED: Claude Code's hooks reference says a SessionStart hook's stdout is
 * added to the session's context, where PreCompact's is documented nowhere. So
 * the session that opens after a compaction is handed the last handoff block of
 * every ledger in the project, bounded, and nothing at all on a startup, a
 * resume, a `/clear` or a fork — none of those lost a context.
 *
 * PostToolUse + Stop — the auto-handoff. The handoff block is written by the
 * session, by discipline, and the discipline fails exactly when it matters: a
 * long turn fills the window and auto-compaction fires before anyone thought of
 * the ledger. So the guard measures the context out of the session transcript's
 * tail, and past a threshold it says so — on `PostToolUse`, whose
 * `additionalContext` reaches the model, and once on `Stop`, which is the only
 * place a turn can be held until the block exists. It nudges once and gates
 * once per crossing; a session that stops again stops. It is silent unless the
 * project keeps a `.omelette/ledger-*.md` — that ledger is the opt-in — and
 * silent inside a sub-agent, which has no ledger of its own.
 *
 * IT NEVER THROWS AND IT NEVER BLOCKS ANYTHING ELSE. Malformed stdin, an
 * unknown event, a ledger it may not write, stdin past the cap, stdin that
 * never closes: exit 0. A hook that crashes is a session that stops working,
 * and this one guards exactly one thing.
 *
 * Zero dependencies, Node >= 20, ESM — it is spawned as `node <this file>`.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// A write to a pipe the harness has stopped reading fails ASYNCHRONOUSLY: the
// EPIPE arrives as an 'error' event after the write() call has already
// returned, so no try/catch around it is still on the stack, and an unhandled
// one crashes the process. On stdout that is a hook that died for nothing; on
// stderr it is worse — the crash replaces the exit 2 a refusal just chose with
// a 1, and the tool call goes through. A pipe nobody reads is not a finding, so
// both are swallowed and THE EXIT CODE THE HANDLER CHOSE SURVIVES.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

/** O_NOFOLLOW where the platform defines it, 0 where it does not — as core/results.mjs does it. */
const NOFOLLOW = constants.O_NOFOLLOW || 0;
/**
 * O_NONBLOCK, on every open this script makes. An lstat is checked before each
 * one, but the open is a SECOND syscall: a FIFO planted between the two would
 * hold `open()` until somebody opened the other end, and a hook that never
 * returns is a session that never runs another tool. With the flag the open
 * returns at once and the fstat behind it refuses whatever is not a regular
 * file. On a regular file the flag means nothing at all, which is the point.
 */
const NONBLOCK = constants.O_NONBLOCK || 0;

/**
 * One option token's VALUE. Written as "a quoted span or a character that is
 * neither quote nor space, repeated" rather than `\S+`, for two reasons:
 *   - a value is quoted the moment it holds a space (`-C "/My Dir"`,
 *     `-c user.name="A B"`), and `\S+` stops at that space;
 *   - and exactly one alternative can start at any position, so the repetition
 *     itself is unambiguous. `(?:"…"|'…'|\S)+` matches the same strings and
 *     takes seconds on a token full of quote characters, because there a `"`
 *     can start either branch.
 */
const OPT_VALUE = '(?:"[^"]*"|\'[^\']*\'|[^\\s"\'])+';

/**
 * The options git accepts BEFORE the subcommand: `-c key=value` / `-C <dir>`
 * attached or spaced, quoted or bare; a long flag with its value attached by
 * `=` or separated by a space; a value-less short flag (`-p`); and the bare
 * `--` separator. Anything in this run is skipped over on the way to the
 * subcommand, so no amount of prefixing hides one.
 *
 * NO TWO ALTERNATIVES MAY READ THE SAME TOKEN, or the run has exponentially
 * many tilings of a command it will not match in the end — and the commands
 * it does not match ARE the hot path: every Bash call in the session. Hence
 * the `(?!-)` on every space-separated value. Without it, ` -c` reads both as
 * its own value-less flag and as the previous option's value, and `git` +
 * ` -c`×N took 5 ms at N=20, 94 ms at N=30 and 11.4 s at N=40; with it every
 * token has exactly one reading and N=200 is 0.01 ms. A value that really does
 * begin with `-` just ends the run there, which costs nothing — the flag is
 * then read as a flag, and the subcommand behind it is still found.
 */
const OPTION_RUN = '(?:'
  + `\\s+-[cC]=?${OPT_VALUE}`
  + `|\\s+-[cC]\\s+(?!-)${OPT_VALUE}`
  + `|\\s+--[\\w-]+(?:=${OPT_VALUE}|\\s+(?!-)${OPT_VALUE})?`
  + '|\\s+-[A-Za-z]'
  + '|\\s+--'
  + ')*';

/** Subcommands that create a commit, or move a stash / worktree — nothing after them makes them read-only. */
const WRITES_HISTORY = 'commit|merge|cherry-pick|revert|am|pull|push|stash|worktree';

/** `git branch` flags that MOVE a ref: rename (`-m`/`-M`), copy (`-c`/`-C`), force-reset (`-f`), upstream (`-u`). */
const BRANCH_WRITES = '-[mMcCfu]|--force|--set-upstream';

/**
 * What a guarded role is never allowed to run, whatever it was asked to do — matched
 * against real git syntax rather than its tidiest form:
 *   - a longer subcommand that merely starts like a forbidden one is NOT this:
 *     `git commit-tree` writes an object and commits nothing, and `merge-base`
 *     only computes — hence `(?![\w-])` on the bare subcommands;
 *   - `git branch` READS (listing, `-d`, `-a`, `-r`, `-v`) until it is handed a
 *     name to create or a flag that moves a ref (BRANCH_WRITES);
 *   - and the branch-creating flags of `checkout`/`switch` may come after other
 *     flags and arguments (`checkout -q -b feat`) or with the name attached to
 *     them (`checkout -bfeat`, and `-B`/`-C` force it), so the scan runs to the
 *     end of the command rather than looking only at the next word. `[^\s;&|]`
 *     keeps that scan inside ONE command instead of crossing `;`, `&&` or `|`.
 *
 * `tag` and `rebase` are not here: a flag anywhere in the invocation decides
 * what they do, so they are classified by reading their arguments — see below.
 *
 * NOT a security boundary: this is containment for a delegated agent that is
 * asked to behave, so an argv-array spawn, a backslash-escaped `g\it`, an alias
 * or `$(which git)` are deliberately out of scope. See docs/SECURITY.md.
 */
const FORBIDDEN = new RegExp(
  `\\bgit${OPTION_RUN}\\s+(?:(?:${WRITES_HISTORY})(?![\\w-])`
  + '|branch(?![\\w-])\\s+(?!-)\\S'
  + `|branch(?![\\w-])(?:\\s+[^\\s;&|]+)*?\\s+(?:${BRANCH_WRITES})`
  + '|checkout(?:\\s+[^\\s;&|]+)*?\\s+(?:-[bB]|--orphan|--track)'
  + '|switch(?:\\s+[^\\s;&|]+)*?\\s+(?:-[cC]|--create|--force-create)'
  + ')',
);

/**
 * Where one subcommand's arguments BEGIN: the match ends just past the
 * subcommand word, and the tokens after it — up to the first separator that is
 * not inside quotes — are its arguments. The tail is not part of the pattern,
 * because `;`, `&&` and `|` mean nothing inside a quoted value and a regex
 * class cannot tell the difference: `git tag --format="x; y" v1` is ONE command
 * whose name is `v1`.
 */
const subcommandCall = (sub) => new RegExp(`\\bgit${OPTION_RUN}\\s+${sub}(?![\\w-])`, 'g');
const TAG_CALL = subcommandCall('tag');
const REBASE_CALL = subcommandCall('rebase');

/**
 * The command with every shell COMMENT removed: from a `#` that starts a line or
 * follows whitespace, outside quotes, to the end of THAT LINE. Per line, because
 * that is where a comment ends — `echo hi # a note` says nothing about the
 * `git tag v1` on the line below it, and reading one as arguments gets the
 * answer backwards in both directions: `git tag v1 # --list` creates a tag, and
 * the `git commit` inside `echo x # git commit` is text. One left-to-right pass,
 * skipped entirely when the command holds no `#` at all.
 */
function withoutComments(command) {
  if (!command.includes('#')) return command;
  let out = '';
  let quote = '';
  let comment = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    // A comment runs to the end of its line; the newline itself is kept,
    // because it is what separates the next command from this one.
    if (comment) { if (c === '\n' || c === '\r') { comment = false; out += c; } continue; }
    if (quote) { out += c; if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(command[i - 1]))) { comment = true; continue; }
    out += c;
  }
  return out;
}

/** What ends one command and starts the next — outside quotes, and never inside them. */
const SEPARATORS = new Set([';', '&', '|', '\n', '\r']);

/**
 * The whole command as TOKENS, in one left-to-right pass: a word, or a
 * separator. A quoted span is opaque — the whitespace and the `;` inside it
 * belong to the value, and a token that OPENS with a quote is a value rather
 * than a flag, so `--exec 'echo --abort now'` is a rebase that runs a command
 * and not a rebase that aborts. Each token carries where it ended, which is how
 * a subcommand match below finds its own arguments.
 *
 * @returns {Array<{text: string, quoted: boolean, separator: boolean, end: number}>}
 */
function tokenize(command) {
  const tokens = [];
  let text = '';
  let quoted = false;
  let quote = '';
  const push = (end) => {
    if (text) tokens.push({ text, quoted, separator: false, end });
    text = '';
    quoted = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) { text += c; if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quoted = quoted || !text; text += c; quote = c; continue; }
    if (SEPARATORS.has(c)) { push(i); tokens.push({ text: c, quoted: false, separator: true, end: i + 1 }); continue; }
    if (/\s/.test(c)) { push(i); continue; }
    text += c;
  }
  push(command.length);
  return tokens;
}

/**
 * The arguments of every `git … <sub>` in the command: the tokens after each
 * match, up to the first unquoted separator. The token cursor only moves
 * forward — a `g` regex hands its matches over in order and they never overlap
 * — so the whole scan stays linear however many invocations there are.
 */
function invocations(re, command, tokens) {
  re.lastIndex = 0;
  const runs = [];
  let i = 0;
  for (let m = re.exec(command); m; m = re.exec(command)) {
    const end = m.index + m[0].length;
    while (i < tokens.length && tokens[i].end <= end) i++;
    const args = [];
    for (let j = i; j < tokens.length && !tokens[j].separator; j++) args.push(tokens[j]);
    runs.push(args);
  }
  return runs;
}

/**
 * `git tag` flags that WRITE a tag: annotate (`-a`), sign (`-s`, `-u <key>`),
 * force (`-f`), delete (`-d`), and the three that supply or groom a message and
 * so imply `-a` — `-m`, `-F`/`--file` and `--cleanup`.
 */
const TAG_WRITE_SHORT = new Set([...'adFfmsu']);
const TAG_WRITE_LONG = new Set(['--annotate', '--cleanup', '--delete', '--file', '--force', '--local-user', '--message', '--sign']);

/**
 * …and the flags that SELECT a listing or a verify mode. Given one of these, the
 * tag name beside it is a pattern or a tag that already exists — `git tag v1
 * --list` lists, it does not create — so it is the mode that decides, not the
 * position of the name. `--format` and `--sort` are NOT here: they decorate a
 * listing without selecting one, and `git tag v1 --format=x` creates `v1`.
 */
const TAG_READ_SHORT = new Set([...'lnv']);
const TAG_READ_LONG = new Set(['--contains', '--list', '--merged', '--no-contains', '--no-merged', '--points-at', '--verify', '--with', '--without']);

/**
 * The options that take a VALUE, whichever way it is written. Attached (`=`, or
 * the rest of a short run) needs nothing; a value that arrives as the NEXT WORD
 * has to be stepped over, or `git tag --sort refname` reads as a tag called
 * `refname` and a listing is blocked as a creation. `-n` is not here: its count
 * is only ever attached (`-n5`), and a bare `-n` swallowing the next word would
 * hide a real name.
 */
const TAG_VALUE_SHORT = new Set([...'mFu']);
const TAG_VALUE_LONG = new Set([
  '--cleanup', '--color', '--column', '--contains', '--format', '--local-user',
  '--merged', '--no-contains', '--no-merged', '--points-at', '--sort',
]);

/**
 * Does this `git tag` write? A write flag always does. Otherwise a positional
 * argument is the tag to CREATE, unless a listing/verify flag turned it into a
 * pattern — listing tags is how an agent finds the last release, and blocking
 * that helps nobody. An option neither set has heard of (`--create-reflog`,
 * `--no-sign`, `--end-of-options`, `--format`, `--sort`) selects no listing
 * mode, so the name behind it is still a name; so is everything after a bare
 * `--`, and so is anything that arrived inside quotes. An option's own value is
 * never a name, whether it came attached or as the next word.
 */
function tagWrites(args) {
  let write = false;
  let reads = false;
  let names = false;
  let afterSeparator = false;
  let takesValue = false;
  for (const { text, quoted } of args) {
    if (afterSeparator) { names = true; continue; }
    if (takesValue) { takesValue = false; continue; } // the previous option's value
    if (quoted) { names = true; continue; }
    if (text === '--') { afterSeparator = true; continue; }
    if (text === '-' || !text.startsWith('-')) { names = true; continue; }
    if (text.startsWith('--')) {
      const eq = text.indexOf('=');
      const name = eq < 0 ? text : text.slice(0, eq);
      if (TAG_WRITE_LONG.has(name)) write = true;
      else if (TAG_READ_LONG.has(name)) reads = true;
      if (eq < 0 && TAG_VALUE_LONG.has(name)) takesValue = true;
      continue;
    }
    // A short run is a cluster: `-am` is `-a -m`, and `-n5` is `-n` with a count.
    // A letter that takes a value ends the run — the rest of the token is that
    // value (`-mmessage`), and a letter sitting last takes the next word.
    for (let k = 1; k < text.length; k++) {
      const ch = text[k];
      if (TAG_WRITE_SHORT.has(ch)) write = true;
      else if (TAG_READ_SHORT.has(ch)) reads = true;
      if (TAG_VALUE_SHORT.has(ch)) { takesValue = k === text.length - 1; break; }
    }
  }
  return write || (names && !reads);
}

/**
 * `git rebase` writes in every form but the ones that UNDO or explain, and
 * those may sit anywhere among the arguments: `--abort` is the recovery an
 * agent stuck mid-rebase needs, `--quit` drops the rebase state, and
 * `--help`/`-h` only print. `--continue` and `--skip` each create a commit, and
 * a bare `git rebase` starts one.
 *
 * WHERE THE WORD SITS DECIDES WHAT IT IS, which is why this reads the arguments
 * the way tagWrites does rather than asking whether `--abort` occurs. An option
 * that takes a VALUE takes the next word whatever it looks like: `git rebase
 * --exec --abort main` is a rebase whose exec command is `--abort` — git 2.38.1
 * replays the commit, answers `error: cannot run --abort`, and leaves the
 * repository in `.git/rebase-merge`. The same for `-x`, for the last letter of
 * a short cluster (`-qx --abort main`), for `--onto`, `--strategy`/`-s` and
 * `--strategy-option`/`-X`, and for the attached `--exec=--abort` form, whose
 * token was never the bare word anyway. And after a bare `--` every token is a
 * POSITIONAL: `git rebase -- --abort` hands `--abort` to git as the upstream
 * (`fatal: invalid upstream '--abort'`), which is a rebase it tried to start.
 *
 * `-S`/`--gpg-sign` is NOT a value-taking option here, though it was until
 * 0.3.4: its key-id is optional and git takes it attached only (`-Skeyid`,
 * `--gpg-sign=keyid`), so the word behind it was never its value — and reading
 * one cost the coder `git rebase -S -h`, a command that prints usage and writes
 * nothing. `git rebase -q --abort` is the same usage error (an action option
 * must be the WHOLE argument list), and both keep passing: nothing is written
 * either way.
 */
const REBASE_READS = new Set(['--abort', '--quit', '--help', '-h']);

/**
 * The rebase options whose value arrives as the NEXT WORD. Short letters are
 * read inside a cluster, so a value-taking letter ends the run exactly as it
 * does in tagWrites: the rest of the token is that value (`-xcmd`), and a
 * letter sitting last takes the word after it.
 *
 * `--whitespace`, `--empty` and `-C` were MEASURED into this set for 0.3.4 (git
 * 2.38.1): each answers `git rebase <option> --abort main` by complaining about
 * the value it was handed — `fatal: Invalid whitespace option: '--abort'`,
 * `fatal: unrecognized empty type '--abort'`, ``fatal: switch `C' expects a
 * numerical value`` — so the word behind them is a value and never the abort it
 * spells. None of the three aborts anything.
 */
const REBASE_VALUE_SHORT = new Set([...'xsXC']);
const REBASE_VALUE_LONG = new Set(['--empty', '--exec', '--onto', '--strategy', '--strategy-option', '--whitespace']);

/**
 * …and the short options whose value is OPTIONAL and only ever ATTACHED: git's
 * parse-options hands one the whole rest of the token and never the next word,
 * so `-SABC` is `--gpg-sign=ABC`. Such a letter ENDS the cluster scan without
 * taking a value — the letters behind it are the key, not more flags: `-SABC`
 * read on past the `S` cost the coder `git rebase -SABC -h`, where the `C` of
 * the key was taken for `-C` and the `-h` behind it for its numeric value.
 */
const REBASE_ATTACHED_SHORT = new Set([...'S']);

/**
 * The value-taking options an ABBREVIATION spells. git accepts any unambiguous
 * prefix of a long option, and the prefix takes the same value the full name
 * does: `git rebase --ex --abort main` is `--exec --abort main`. Two letters and
 * up behind the dashes (`--ex` and longer), because that is where an
 * abbreviation somebody typed on purpose starts; an ambiguous one git would
 * refuse costs nothing to over-block, since the command it refuses writes
 * nothing.
 */
const rebaseTakesValue = (name) => REBASE_VALUE_LONG.has(name)
  || (name.length >= 4 && [...REBASE_VALUE_LONG].some((full) => full.startsWith(name)));

/**
 * A token's text with its QUOTING removed — what the shell hands git.
 *
 * QUOTING STARTS WHEREVER IT STARTS. `"--exec"`, `--'exec'` and `--ex"ec"` are
 * the same one word by the time git sees it, and only the first of them opens
 * with a quote: reading the other two as unknown options is what let `git
 * rebase --ex"ec" --abort main` — a rebase whose exec command is `--abort` —
 * pass until 0.3.4. A quote character INSIDE a span opened by the other one is
 * a literal character (`"it's"` is `it's`), exactly as tokenize reads them.
 */
function unquote(text) {
  let out = '';
  let quote = '';
  for (const c of text) {
    if (quote) { if (c === quote) quote = ''; else out += c; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    out += c;
  }
  return out;
}

/**
 * Does this `git rebase` write? Only an undo or an explain flag standing on its
 * OWN account says no: one that arrived inside quotes is text, one sitting in an
 * option's value position is that value, and one behind a `--` is a positional.
 *
 * QUOTING HIDES AN ACTION WORD AND NOTHING ELSE. The quotes come off every
 * token before it is classified, wherever in it they sit, so `"--exec"`,
 * `--'exec'` and `--ex"ec"` all take the next word exactly as the bare form
 * does; it is only the ACTION words — `--abort` and the rest of REBASE_READS —
 * that a token carrying any quoting at all cannot be, because quoting is how
 * `--exec 'echo --abort now'` says the word is data. A recovery flag spelled
 * with quotes in it is refused rather than guessed at: that costs a command an
 * agent can retype, where the other reading costs a rebase that ran.
 */
function rebaseWrites(args) {
  let afterSeparator = false;
  let takesValue = false;
  for (const { text } of args) {
    if (afterSeparator) continue; //                    a positional, however it is spelled
    if (takesValue) { takesValue = false; continue; } // the previous option's value
    const token = unquote(text);
    // `token === text` is exactly "this token carried no quote character",
    // which is what an action word has to be; everything else is data.
    if (token === text && REBASE_READS.has(token)) return false;
    if (token === '--') { afterSeparator = true; continue; }
    if (token === '-' || !token.startsWith('-')) continue;
    if (token.startsWith('--')) {
      // An attached value (`--exec=--abort`) needs no skip: the token is not the
      // bare word, so nothing behind it was ever a candidate.
      if (!token.includes('=') && rebaseTakesValue(token)) takesValue = true;
      continue;
    }
    for (let k = 1; k < token.length; k++) {
      const ch = token[k];
      if (REBASE_ATTACHED_SHORT.has(ch)) break; //     the rest of the token is its key, and the next word is not
      if (REBASE_VALUE_SHORT.has(ch)) { takesValue = k === token.length - 1; break; }
    }
  }
  return true;
}

/**
 * Everything a guarded role may not run, in one question: the comments come off, the
 * command is tokenized once, and the three classifiers read that. Each step is a
 * single pass, so a 10 KB command costs milliseconds and never a tiling.
 */
const forbidden = (raw) => {
  const command = withoutComments(raw);
  if (FORBIDDEN.test(command)) return true;
  const tokens = tokenize(command);
  return invocations(TAG_CALL, command, tokens).some(tagWrites)
    || invocations(REBASE_CALL, command, tokens).some(rebaseWrites);
};
/**
 * THE ROLES THIS GUARD CONTAINS. Both shipped definitions run the same Bash
 * tool and the operating model asks the same thing of both — the coder reports
 * instead of committing, the tester runs the suite and reports what it saw —
 * but until 0.3.4 only the coder's half was ENFORCED and the tester's was prose.
 * A tester that stashed the tree to get a clean run was hiding the very diff the
 * orchestrator was about to review, and nothing stopped it.
 *
 * A name is matched WHOLE: `omelette-coder-2` is somebody else's agent, and the
 * main thread carries no `agent_type` at all.
 *
 * The refusal NAMES the agent it caught. Two roles reading one another's line is
 * how an agent decides the block was meant for somebody else.
 */
const GUARDED_AGENTS = new Set(['omelette-coder', 'omelette-tester']);
const REFUSAL = (agent) => `${agent} never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead`;
const HANDOFF = 'HANDOFF: re-read .omelette/ledger-*.md before continuing.';

/**
 * Stdin is somebody else's pipe: it can be far bigger than any real event and
 * it can simply never close. Both are answered the same way — stop, and exit 0
 * — because a guard that buffers without bound or waits without end is a
 * session that hangs on every tool call.
 *
 * The cap is 8 MiB rather than a tidier 1: a `PostToolUse` event carries the
 * tool's own `tool_response`, and a few megabytes of command output on one call
 * is ordinary. Giving up on an event that large would drop the very reminder
 * this guard exists to send — and, on a `PreToolUse`, a refusal.
 */
const MAX_STDIN = 8 * 1024 * 1024; // 8 MiB — well above a real hook event, and above a big one
const STDIN_DEADLINE_MS = 5000;

const str = (v, fallback = '') => (typeof v === 'string' && v ? v : fallback);

/** A plain object — what every record this guard reads has to be before it is read. */
const isObject = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

/**
 * WHAT `rules --hooks` RENDERED HERE. This script imports nothing from the
 * package — it is copied into a project as one file — so the operator's
 * `handoff` block arrives as a JSON literal substituted at render time, exactly
 * the way the version marker is. `doctor` reads THIS LINE back out of the installed
 * script, which is how a threshold changed in the config and never re-rendered
 * is visible instead of merely wrong.
 */
const HANDOFF_CONFIG = {{handoff}};

/**
 * …the same values, defended against a literal somebody edited by hand: out of
 * range is the built-in, never a throw and never a percentage that cannot fire.
 */
const whole = (v, min, max, fallback) => (Number.isInteger(v) && v >= min && v <= max ? v : fallback);
const AUTO_HANDOFF = {
  enabled: !isObject(HANDOFF_CONFIG) || HANDOFF_CONFIG.enabled !== false,
  threshold: whole(isObject(HANDOFF_CONFIG) ? HANDOFF_CONFIG.threshold : null, 50, 99, 90),
  contextWindow: whole(isObject(HANDOFF_CONFIG) ? HANDOFF_CONFIG.contextWindow : null, 0, Number.MAX_SAFE_INTEGER, 0),
};

/** The whole event, or null: stdin that never arrives, never parses, never ends or never stops is not an error here. */
async function readEvent() {
  let raw = '';
  let gaveUp = false;
  const giveUp = () => { gaveUp = true; process.stdin.destroy(); };
  const deadline = setTimeout(giveUp, STDIN_DEADLINE_MS);
  try {
    const chunks = [];
    let size = 0;
    for await (const c of process.stdin) {
      size += c.length;
      if (size > MAX_STDIN) { giveUp(); break; }
      chunks.push(c);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } catch { return null; } finally { clearTimeout(deadline); }
  if (gaveUp) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/**
 * Anything this guard says, on a stream somebody else owns. A closed or broken
 * pipe is not a reason to fail a tool call, a compaction or a session start —
 * only a PreToolUse refusal ever leaves a non-zero code, and it sets that BEFORE
 * it writes, so even a stderr that will not take the reason still blocks.
 */
function say(stream, text) {
  try { stream.write(text); } catch { /* a pipe nobody is reading is not a finding */ }
}

/** Exit 2 = "do not run this", with the reason on stderr for the agent to read. */
function preToolUse(event) {
  const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
  const agent = str(event.agent_type);
  if (!GUARDED_AGENTS.has(agent) || event.tool_name !== 'Bash') return;
  if (!forbidden(str(input.command))) return;
  // exitCode, not exit(): the process leaves on its own once stderr is flushed.
  // Set first, so a stderr that cannot be written to still refuses the call.
  process.exitCode = 2;
  say(process.stderr, `${REFUSAL(agent)}\n`);
}

/**
 * This project's ledger directory, or null when neither event may touch it.
 * `<cwd>/.omelette` is lstatted (never stat): a SYMLINK there sends every
 * append and every read out of the project, and the per-ledger lstat below
 * cannot see it — the files inside the link are perfectly regular. Anything
 * else that is not a directory is refused the same way, in silence.
 *
 * A directory that is simply ABSENT is neither: that is a project with no
 * ledger yet, which is normal and says nothing about what may be done.
 *
 * @returns {object|null} `dir` and `exists`, or null when the path is not ours
 *   to touch. Written flat rather than as an inline type, because a doubled
 *   brace is the renderer's placeholder syntax and never survives rendering.
 */
function ledgerDir(event) {
  const dir = join(str(event.cwd, process.cwd()), '.omelette');
  let st = null;
  try { st = lstatSync(dir); } catch (e) { return e && e.code === 'ENOENT' ? { dir, exists: false } : null; }
  return st.isDirectory() && !st.isSymbolicLink() ? { dir, exists: true } : null;
}

/** Mark every ledger in this project, then say so on stdout. */
function preCompact(event) {
  const found = ledgerDir(event);
  if (!found) return; // a `.omelette` that is not ours to write: no marker, and nothing to announce
  const line = `\n## Compaction ${new Date().toISOString()} (trigger: ${str(event.trigger, 'unknown')}) — re-read this ledger before continuing\n`;
  const ledgers = found.exists ? ledgerNames(found.dir) : [];
  for (const name of ledgers) {
    // A ledger we cannot write is not a reason to fail somebody's compaction —
    // and one that is not a REGULAR file is not a ledger at all: lstat (never
    // stat) so a symlink is seen as a symlink and skipped instead of followed
    // out of .omelette, and a FIFO named like a ledger is skipped instead of
    // blocking the append until somebody opens the other end.
    //
    // Then O_NOFOLLOW on the open itself, because the lstat and the append are
    // two syscalls: a link planted between them is what the flag answers.
    const path = join(found.dir, name);
    let fd = null;
    try {
      if (!lstatSync(path).isFile()) continue;
      fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW | NONBLOCK);
      if (!fstatSync(fd).isFile()) continue;
      writeSync(fd, line);
    } catch { /* ignore */ } finally {
      if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
    }
  }
  // The window this session crossed is about to be replaced. Its crossing
  // described a context that will not exist in a moment — and the sizes it
  // recorded describe a ledger this very handler has just stamped — so it goes
  // with it, and the next window crosses on its own terms.
  resetHandoff(found, event);
  say(process.stdout, `${HANDOFF}\n`);
}

/** A level-2 heading, and the one that opens a handoff block. `### Handoff` is neither. */
const HEADING = /^##\s/;

/**
 * THE HANDOFF HEADING, in ONE grammar for the two readers that ask about it —
 * the SessionStart print and the freshness gate. They disagreed until 0.3.4,
 * and a heading the gate refused while the print showed it is the worst of both
 * answers: the turn is held for a block the next context is then handed.
 *
 * `[ \t]` and not `\s`, because a `\s` spans the newline and `##\nHandoff` is
 * two lines, neither of them a handoff heading. `\b` and not the bare word,
 * because `## Handoffs, and why we write them` is a heading ABOUT handoffs.
 * The grammar is one string and the flags are what differ: the print reads a
 * line at a time, the gate scans a whole buffer.
 */
const HANDOFF_HEADING_SOURCE = '^##[ \\t]+handoff\\b';
const HANDOFF_HEADING = new RegExp(HANDOFF_HEADING_SOURCE, 'i');
const FRESH_HANDOFF = new RegExp(HANDOFF_HEADING_SOURCE, 'im');

/** A fenced block's delimiter, indented up to 3 spaces, as Markdown spells one. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const TRUNCATED = '[… truncated]';

/**
 * THE LAST HANDOFF BLOCK of one ledger: from the last `## Handoff` heading to
 * the next `## ` heading or the end of the file. The LAST one, because a ledger
 * accumulates them and only the newest describes where the work stands.
 *
 * Headings inside a FENCED block are text, not headings — a ledger quoting its
 * own vocabulary (this repository's does) would otherwise have its block cut in
 * half by an example. Fences are tracked the way Markdown reads them: ``` or
 * ~~~, closed only by the same character at least as long.
 *
 * Capped twice, because what this returns is pasted into a fresh model context
 * and a ledger is somebody's free-form file: `maxLines` lines and `maxBytes`
 * bytes, whichever runs out first, with a `[… truncated]` line saying the rest
 * was dropped. The caps are HARD — a single line longer than `maxBytes` leaves
 * the block as that one marker, which is the honest answer for a paste that is
 * not a handoff.
 *
 * @returns {string} the block without its trailing blank lines, or '' when the
 *   ledger has no handoff block at all.
 */
function lastHandoffBlock(text, { maxLines = 40, maxBytes = 4096 } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  let fence = '';
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = '';
      continue;
    }
    if (fence || !HEADING.test(lines[i])) continue;
    // A later handoff heading replaces the one found so far, and reopens the
    // search for the heading that ends it.
    if (HANDOFF_HEADING.test(lines[i])) { start = i; end = lines.length; continue; }
    if (start >= 0 && end === lines.length) end = i;
  }
  if (start < 0) return '';

  const block = lines.slice(start, end);
  while (block.length && !block[block.length - 1].trim()) block.pop();
  const kept = [];
  let bytes = 0;
  for (const line of block) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (kept.length >= maxLines || bytes + size > maxBytes) { kept.push(TRUNCATED); break; }
    kept.push(line);
    bytes += size;
  }
  return kept.join('\n');
}

/** One ledger is read at most this far; the whole print is bounded on top of that. */
const LEDGER_READ_MAX = 1024 * 1024; // 1 MiB
const HANDOFF_TOTAL_MAX = 12 * 1024;
/**
 * Said above a block that came out of a tail read, so nobody reads it as the
 * whole file — and so nobody trusts its structure either: the read starts
 * mid-file, so an opening ``` above the offset is not seen, and the fence
 * tracking below can take real headings for quoted ones or quoted ones for real.
 */
const TAIL_NOTE = '[… ledger larger than 1 MiB — read from its tail; a fenced block cut by the read may hide or fake a heading]';

/**
 * The handoff, back into the context that just lost it. Only `source ===
 * 'compact'`: a startup, a resume, a `/clear` and a fork have a context nobody
 * lost, and printing a handoff into each of them is noise on every session.
 *
 * Same ledgers as PreCompact and the same rule about them — `<cwd>/.omelette/
 * ledger-*.md`, sorted, a directory that is not a symlink (ledgerDir), lstat
 * (never stat) so a symlink under that name is seen and skipped rather than
 * followed out of the directory, O_NOFOLLOW on the open against the race
 * between those two syscalls, and a FIFO skipped rather than blocking the read.
 *
 * Each file is read at most 1 MiB FROM ITS TAIL — a ledger grows by appending,
 * so the last handoff is at the END, and a head-first read of a long-running
 * plan's ledger hands the next context a block that was superseded weeks ago.
 * A tail read says so, above the block, because it is not the whole file.
 *
 * Each block is bounded by lastHandoffBlock, and the print as a whole stops at
 * 12 KB: a ledger that does not fit is dropped WHOLE, with one truncation line,
 * because half a handoff read as a whole one is worse than a line saying it was
 * left out.
 *
 * Nothing to print is printed as nothing: no header, no blank line, exit 0.
 */
function sessionStart(event) {
  if (str(event.source) !== 'compact') return;
  const found = ledgerDir(event);
  if (!found || !found.exists) return;
  const ledgers = ledgerNames(found.dir);
  if (!ledgers.length) return;

  const buf = Buffer.alloc(LEDGER_READ_MAX);
  const parts = [];
  let total = 0;
  for (const name of ledgers) {
    const path = join(found.dir, name);
    let text = '';
    let tailed = false;
    try {
      if (!lstatSync(path).isFile()) continue;
      const fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
      try {
        // fstat, on the descriptor actually opened: it is the size the read is
        // about to use, and it settles what lstat only said a moment ago.
        const st = fstatSync(fd);
        if (!st.isFile()) continue;
        const offset = Math.max(0, st.size - LEDGER_READ_MAX);
        tailed = offset > 0;
        text = buf.subarray(0, readSync(fd, buf, 0, LEDGER_READ_MAX, offset)).toString('utf8');
      } finally { closeSync(fd); }
    } catch { continue; } // a ledger we may not read is not a reason to fail a session start
    const block = lastHandoffBlock(text);
    if (!block) continue;
    const part = `${parts.length ? '\n' : ''}--- ${name} · last handoff ---\n${tailed ? `${TAIL_NOTE}\n` : ''}${block}\n`;
    const size = Buffer.byteLength(part, 'utf8');
    if (total + size > HANDOFF_TOTAL_MAX) { parts.push(`${TRUNCATED}\n`); break; }
    parts.push(part);
    total += size;
  }
  if (parts.length) say(process.stdout, parts.join(''));
}

// ─── the auto-handoff: measure the context, ask for the block, hold one turn ──

/**
 * A sub-agent's event carries its identity and the main thread's carries none.
 * Everything below is about the session's own ledger, and a sub-agent has none:
 * nudging it would spend a delegate's context on a block it must not write.
 */
const present = (v) => v !== undefined && v !== null && v !== '';
const inSubagent = (event) => present(event.agent_id) || present(event.agent_type);

/** Claude Code's own name for the window it auto-compacts against, and the default it documents. */
const CEILING_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const CEILING_SETTING = 'autoCompactWindow';
const CEILING_DEFAULT = 200000;
/**
 * …and the other thing a 1M session says about itself. Claude Code writes the
 * model it is running into the user's settings, suffix and all, and `[1m]` IS
 * the 1 000 000-token window: `claude-opus-5[1m]`, `claude-fable-5-1[1m]`. It
 * is read only once `autoCompactWindow` has said nothing — a window capped on
 * purpose was meant — and it beats the 200 000 default, which is wrong for
 * every 1M session and read one as 144 % full on the day 0.3.4 shipped.
 *
 * `core/rules.mjs` carries the same rule as `parseModelWindow`. This script
 * imports nothing, so what is below is a COPY, and the two are pinned against
 * one table.
 */
const MODEL_ENV = 'ANTHROPIC_MODEL';
const MODEL_SETTING = 'model';
const MODEL_WINDOW = 1000000;
const MODEL_WINDOW_SOURCE = 'model[1m]';
const ONE_M_SUFFIX = /\[1m\]$/i;
/** How much of the transcript is read: the answer is always at its end. */
const TRANSCRIPT_TAIL_MAX = 256 * 1024;
/** One integer and one model id are taken out of a settings file, and even those reads are bounded. */
const SETTINGS_READ_MAX = 1024 * 1024;
/** The counters that make up the PROMPT that was just sent. `output_tokens` is the answer, not the prompt. */
const USAGE_KEYS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

/**
 * At most `maxBytes` of a file — from `from`, or with `tail` from its END.
 * Regular files only: lstat first, so a symlink under the name is SEEN, then
 * O_NOFOLLOW on the open against the race between the two syscalls, then fstat
 * on the descriptor actually opened. A FIFO is skipped rather than blocking the
 * read until somebody opens the other end.
 *
 * `follow` is the one exception, and it is only ever used for Claude Code's own
 * settings files: a dotfile setup legitimately keeps those behind a link, one
 * integer is read out of them, and nothing is ever written through the read.
 * That read has no lstat to lean on, which is precisely why the open carries
 * O_NONBLOCK: the fstat is what refuses a pipe, and it only runs if the open
 * came back.
 *
 * @returns {string|null} the bytes as UTF-8, or null when there is nothing here
 *   this guard may read.
 */
function readBounded(path, maxBytes, { tail = false, from = 0, follow = false } = {}) {
  let fd = null;
  try {
    if (!follow && !lstatSync(path).isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | NONBLOCK | (follow ? 0 : NOFOLLOW));
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const start = tail ? Math.max(from, st.size - maxBytes) : from;
    const length = Math.max(0, Math.min(maxBytes, st.size - start));
    if (!length) return '';
    const buf = Buffer.alloc(length);
    return buf.subarray(0, readSync(fd, buf, 0, length, start)).toString('utf8');
  } catch { return null; } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * `200000`, `500k`, `1m` — the forms Claude Code documents for that window,
 * case-insensitive and decimal (`k` is 1000, `m` is 1000000). Anything else is
 * not a window and is refused rather than guessed at: a fraction, a separator,
 * a negative, a blank. No measurement beats a wrong one.
 */
const WINDOW_FORM = /^(\d+)([km])?$/i;
function parseWindow(raw) {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const m = WINDOW_FORM.exec(raw.trim());
  if (!m) return null;
  const scale = !m[2] ? 1 : m[2].toLowerCase() === 'k' ? 1000 : 1000000;
  const n = Number(m[1]) * scale;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * THE CONTEXT FILL: the tokens the model was handed on the last request, which
 * is what the next one grows from. Claude Code writes one JSON object per line
 * and only its assistant records carry `message.usage`; the LAST such record is
 * the newest, and `input + cache_read + cache_creation` is its prompt.
 *
 * Only the last 256 KiB are read — a transcript is megabytes and the newest
 * record is at its end — so the first line of that read is usually half a
 * record. It simply fails to parse, like any other line that is not one.
 *
 * A COUNTER THAT IS PRESENT HAS TO BE A COUNT: a whole, non-negative, safe
 * number, and their sum one too. `Number()` would take `[180000]`, `"180000"`
 * and `true` for counts, and a `1e308` would make a percentage out of a value
 * no arithmetic here can hold. None of that is a measurement, and the record
 * before it is not one either: it describes a context two turns old, so an
 * unreadable newest record answers null rather than falling back to it. Absent
 * is different from unreadable and still counts as 0.
 *
 * @returns {number|null} null when there is no measurement to be had.
 */
function transcriptFill(path) {
  const text = readBounded(path, TRANSCRIPT_TAIL_MAX, { tail: true });
  if (text === null) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    let rec = null;
    try { rec = JSON.parse(line); } catch { continue; }
    const usage = isObject(rec) && isObject(rec.message) ? rec.message.usage : null;
    if (!isObject(usage)) continue;
    let fill = 0;
    for (const key of USAGE_KEYS) {
      const n = usage[key];
      if (n === undefined) continue; // a counter this request did not use
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return null;
      fill += n;
    }
    return Number.isSafeInteger(fill) ? fill : null;
  }
  return null;
}

/**
 * ONE TOP-LEVEL KEY out of the USER's own Claude Code settings: the pair under
 * `$CLAUDE_CONFIG_DIR` or `~/.claude`, the local file first, as the client
 * reads them. The first file whose value `accept` takes wins; a file that is
 * absent, unreadable, not JSON, not an object, or simply silent about this key
 * is skipped and the NEXT one is read.
 *
 * That fall-through is the whole contract. `settings.local.json` holding
 * `"autoCompactWindow": "garbage"` and `settings.json` holding `"500k"` is a
 * 500 000 window, and doctor's `readClientSetting` walks the same two files the
 * same way — so the line it prints and the window this hook measures against
 * cannot disagree. The project's own settings are not read here: a `.claude`
 * anywhere but the user's scope belongs to a project, and this window does not.
 *
 * @returns {any} whatever `accept` returned for the first file that had one, or
 *   null when none did — a falsy answer from `accept` means "not this file's".
 */
function userSetting(env, key, accept) {
  const dir = String(env.CLAUDE_CONFIG_DIR || '').trim() || join(homedir(), '.claude');
  for (const name of ['settings.local.json', 'settings.json']) {
    const text = readBounded(join(dir, name), SETTINGS_READ_MAX, { follow: true });
    if (text === null) continue;
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { continue; }
    if (!isObject(parsed)) continue;
    const value = accept(parsed[key]);
    if (value) return value;
  }
  return null;
}

/** The `[1m]` suffix, and only the suffix: trimmed, case-insensitive, and it has to END the id. */
const isOneM = (raw) => typeof raw === 'string' && ONE_M_SUFFIX.test(raw.trim());

/**
 * THE 1M WINDOW A MODEL ID ANNOUNCES: `ANTHROPIC_MODEL` in this hook's own
 * environment first, then the `model` key of the same two settings files.
 * Nothing else about the id is read — a name this script has never heard of
 * still says what its suffix says — and nothing about it is ever printed.
 *
 * NOT INFERRED: a `[1m]` passed only on the command line (`claude --model
 * …[1m]`). A hook sees the environment and the settings files, never the
 * client's argv, so that session wants `handoff.contextWindow` or the setting.
 *
 * @returns {object|null} `window` and `source`, or null when nothing said 1M.
 */
function modelWindow(env) {
  const found = isOneM(env[MODEL_ENV]) || userSetting(env, MODEL_SETTING, (raw) => (isOneM(raw) ? MODEL_WINDOW : null));
  return found ? { window: MODEL_WINDOW, source: MODEL_WINDOW_SOURCE } : null;
}

/**
 * The window the fill is measured against, and WHERE that number came from —
 * the nudge says so, because "91% of 200000" is only actionable next to the
 * reason it is 200000. First source that yields a positive integer wins: the
 * rendered `handoff.contextWindow`, then the variable Claude Code documents,
 * then `autoCompactWindow` in the USER's own settings (the local file first, as
 * the client reads them), then a model id ending in `[1m]`, then Claude Code's
 * 200 000.
 *
 * The order is by SOURCE and not by file: `autoCompactWindow` is resolved
 * across both files before a `model` key is looked at in either, so a window
 * the operator capped in `settings.json` beats the suffix in
 * `settings.local.json`.
 */
function contextCeiling(env) {
  if (AUTO_HANDOFF.contextWindow > 0) return { window: AUTO_HANDOFF.contextWindow, source: 'handoff.contextWindow' };
  const fromEnv = parseWindow(env[CEILING_ENV]);
  if (fromEnv) return { window: fromEnv, source: CEILING_ENV };
  const fromSettings = userSetting(env, CEILING_SETTING, parseWindow);
  if (fromSettings) return { window: fromSettings, source: CEILING_SETTING };
  return modelWindow(env) || { window: CEILING_DEFAULT, source: 'default' };
}

/**
 * How full the context is, as a whole percent, FLOORED — 89.9 % is 89, and the
 * threshold is crossed when it is really crossed.
 *
 * @returns {object|null} `percent`, `fill`, `window` and `source` — or null
 *   whenever anything at all was unreadable: no measurement is the one answer
 *   that never blocks a turn on a guess. The shape is spelled out rather than
 *   typed, because a doubled brace in this file is a render-time placeholder.
 */
function measure(event, env = process.env) {
  const path = str(event.transcript_path);
  if (!path) return null;
  const fill = transcriptFill(path);
  if (fill === null) return null;
  const ceiling = contextCeiling(env);
  return { percent: Math.floor((fill * 100) / ceiling.window), fill, window: ceiling.window, source: ceiling.source };
}

/** This project's ledgers, sorted — the same set PreCompact stamps and SessionStart prints. */
function ledgerNames(dir) {
  try { return readdirSync(dir).filter((f) => /^ledger-.*\.md$/.test(f)).sort(); } catch { return []; }
}

/** Their sizes at this instant: the offsets a later read measures "appended since" against. */
function ledgerSizes(dir, names) {
  const sizes = {};
  for (const name of names) {
    try { const st = lstatSync(join(dir, name)); if (st.isFile()) sizes[name] = st.size; } catch { /* gone counts as 0 */ }
  }
  return sizes;
}

const STATE_FILE = 'handoff-state.json';
const STATE_READ_MAX = 256 * 1024;
const STATE_MAX_ENTRIES = 64;
const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How far past a ledger's recorded size the freshness scan reads. */
const APPEND_READ_MAX = 64 * 1024;

/**
 * THE STATE, or the fact that there is none to be had. One entry per session:
 * when it crossed, how big every ledger was at that moment, and whether the
 * reminder and the gate have already fired.
 *
 * A symlink, a directory or a FIFO under that name is not ours to read and
 * never ours to rename over — that is `usable: false`, and the caller says
 * nothing at all rather than write through it. So is a file past the read cap
 * and one the open or the read refuses. A regular file of OURS whose JSON no
 * longer parses is a different case: it is rewritten from an empty map, because
 * one corrupt byte must not disable the mechanism for a project forever.
 *
 * @returns {object} `state` (the map) and `usable` (whether it may be written).
 */
function readState(dir) {
  const path = join(dir, STATE_FILE);
  let st = null;
  try { st = lstatSync(path); } catch (e) { return { state: {}, usable: !!e && e.code === 'ENOENT' }; }
  if (!st.isFile() || st.size > STATE_READ_MAX) return { state: {}, usable: false };
  const text = readBounded(path, STATE_READ_MAX);
  if (text === null) return { state: {}, usable: false };
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { return { state: {}, usable: true }; }
  return { state: isObject(parsed) ? parsed : {}, usable: true };
}

/**
 * The state back to disk: 0600, a temporary file opened with O_EXCL and
 * O_NOFOLLOW, then a rename — so a reader never sees half a map and a planted
 * link is never written through. A tmp file that is already there belongs to
 * somebody else and is left exactly as it is.
 *
 * ONE SESSION'S CHANGE, ONTO THE MAP AS IT IS NOW. The file is re-read here
 * rather than written back from the snapshot the handler read at the top of its
 * run: this file is one per PROJECT and two sessions in it overlap constantly —
 * one reads, the other crosses and writes, the first writes its snapshot back
 * and the second session's crossing is gone. So the change is a `set` or a
 * `remove` of ONE id, applied to what is on disk at this instant.
 *
 * Pruned on every write, because sessions are many: entries older than 7 days
 * go and the newest 64 survive; then, while the JSON is still past the size
 * this file is READ under, the oldest go one at a time — a state file past
 * STATE_READ_MAX is one readState refuses from then on, which would switch the
 * mechanism off for that project for good. `keep` is the session being written
 * and survives all three, and when its entry ALONE does not fit, nothing is
 * written at all.
 *
 * A write that fails is silent, and its caller says nothing either: a hook that
 * could not record that it nudged would nudge again on every tool call.
 *
 * @param change one of two shapes — `set` with the id and its entry, or
 *   `remove` with the id to drop. Written flat rather than as an inline type,
 *   because a doubled brace is the renderer's placeholder syntax and never
 *   survives rendering.
 * @returns {boolean} whether the rename actually happened.
 */
function writeState(dir, change) {
  const { state, usable } = readState(dir);
  if (!usable) return false;
  const keep = change.set ? change.set[0] : null;
  if (change.set) state[keep] = change.set[1];
  else if (change.remove) delete state[change.remove];

  const now = Date.now();
  const age = (entry) => {
    const t = Date.parse(isObject(entry) ? entry.crossedAt : '');
    return Number.isFinite(t) ? now - t : Infinity;
  };
  const kept = Object.entries(state)
    .filter(([id, entry]) => isObject(entry) && (id === keep || age(entry) <= STATE_MAX_AGE_MS))
    .sort((a, b) => (a[0] === keep ? -1 : b[0] === keep ? 1 : age(a[1]) - age(b[1])))
    .slice(0, STATE_MAX_ENTRIES);
  const serialise = (entries) => {
    const next = {};
    for (const [id, entry] of entries) next[id] = entry;
    return JSON.stringify(next);
  };
  // `keep` sorts first, so the tail of the list is the oldest entry there is.
  let entries = kept;
  let json = serialise(entries);
  while (Buffer.byteLength(json) > STATE_READ_MAX && entries.length > (keep ? 1 : 0)) {
    entries = entries.slice(0, -1);
    json = serialise(entries);
  }
  if (Buffer.byteLength(json) > STATE_READ_MAX) return false;

  const path = join(dir, STATE_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  let fd = null;
  let created = false;
  let renamed = false;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    created = true;
    // WRITTEN TO THE LAST BYTE BEFORE THE RENAME. writeSync reports how much it
    // actually took, and a short write is only a failure if the rest is never
    // sent: half a map renamed into place is JSON that no longer parses, which
    // readState answers by rewriting the file from empty — every crossing this
    // project recorded gone, and every session nudged again. A write that takes
    // nothing at all is a write that is not progressing, and the finally below
    // closes the descriptor and takes the temporary file with it.
    const buf = Buffer.from(json);
    for (let off = 0; off < buf.length;) {
      const written = writeSync(fd, buf, off, buf.length - off);
      if (written <= 0) return false;
      off += written;
    }
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    created = false; // the rename took the name with it
    renamed = true;
  } catch { /* a note we could not write is not a reason to fail a turn */ } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
    if (created) { try { unlinkSync(tmp); } catch { /* nothing to clean up */ } }
  }
  return renamed;
}

/**
 * Has a handoff been APPENDED since the crossing? Every ledger is read from the
 * size it had at that moment — at most 64 KiB of it — and a `^## Handoff` line
 * in those bytes is the block. Nothing else counts: a `Ruling:` line is not a
 * handoff and neither is the `## Compaction` stamp, and a block written before
 * the crossing sits behind the offset where it belongs.
 *
 * A ledger created after the crossing has no recorded size and counts from its
 * first byte, which is the whole of it.
 *
 * THE READ STARTS ONE BYTE EARLY, because `^` is only a line start if a line
 * ended there. A ledger whose last line carried no newline — a half-written
 * `Ruling:`, a `printf` without one — makes `…mid-line## Handoff` out of the
 * next append, which is text, and reading from the recorded offset alone would
 * see `## Handoff` sitting at byte 0 and call it a heading. So the byte before
 * the offset is read too: a newline there means the appended bytes open a line
 * of their own, and anything else means the first line of the read is the tail
 * of an older one and is dropped. Offset 0 is exempt — a file's first byte
 * begins a line by definition.
 */
function freshHandoff(dir, names, entry) {
  const recorded = isObject(entry) && isObject(entry.ledgers) ? entry.ledgers : {};
  for (const name of names) {
    const size = recorded[name];
    const offset = Number.isInteger(size) && size > 0 ? size : 0;
    const from = offset > 0 ? offset - 1 : 0;
    let text = readBounded(join(dir, name), APPEND_READ_MAX, { from });
    if (!text) continue;
    if (offset > 0 && text[0] !== '\n') {
      // The read opened mid-line: everything up to the first newline belongs to
      // a line that started before the crossing, and the newline itself is kept
      // so the line after it is still a line start.
      const nl = text.indexOf('\n');
      text = nl < 0 ? '' : text.slice(nl);
    }
    if (text && FRESH_HANDOFF.test(text)) return true;
  }
  return false;
}

/** The ledger the messages point at: the one, when there is one — otherwise the directory. */
const ledgerTarget = (names) => (names.length === 1 ? `.omelette/${names[0]}` : 'one of the ledgers in .omelette/');

const nudgeText = (m, names) => `omelette-fleet: context at ${m.percent}% of ${m.window} tokens (${m.source}). `
  + `Append a \`## Handoff\` block to ${ledgerTarget(names)} now — where the work stands, open findings, `
  + 'agents in flight, next action — auto-compaction is close.';

/**
 * Everything both handlers need, or null when this session is not one the guard
 * has anything to say about: the block switched off, a sub-agent, an event with
 * no session id, a `.omelette` that is not ours or is not there, NO LEDGER AT
 * ALL (the ledger is how a project opts in), a state file we may not use, or no
 * measurement.
 */
function handoffContext(event) {
  if (!AUTO_HANDOFF.enabled) return null;
  if (inSubagent(event)) return null;
  const id = str(event.session_id);
  if (!id) return null;
  const found = ledgerDir(event);
  if (!found || !found.exists) return null;
  const names = ledgerNames(found.dir);
  if (!names.length) return null;
  const { state, usable } = readState(found.dir);
  if (!usable) return null;
  const m = measure(event);
  if (!m) return null;
  // The map itself does not travel: writeState re-reads it, so a handler that
  // carried it would only be tempted to write a snapshot back.
  return { id, dir: found.dir, names, entry: isObject(state[id]) ? state[id] : null, m };
}

/**
 * THE NUDGE. Past the threshold, once per crossing, one JSON object whose
 * `additionalContext` Claude Code puts into the session's context — which is
 * the whole reason this lives on `PostToolUse` and not on `PreCompact`, whose
 * stdout is promised nowhere and which runs after the decision to compact.
 *
 * The crossing is recorded and the reminder said in the SAME run: auto-
 * compaction is close by then, and the next tool call may never come. Below the
 * threshold the crossing is dropped instead — a window that fell back was
 * compacted or trimmed, and the sizes it recorded describe a context that is
 * gone.
 */
function postToolUse(event) {
  const ctx = handoffContext(event);
  if (!ctx) return;
  const { id, dir, names, m } = ctx;
  if (m.percent < AUTO_HANDOFF.threshold) {
    if (ctx.entry) writeState(dir, { remove: id });
    return;
  }
  const entry = ctx.entry || {
    crossedAt: new Date().toISOString(), ledgers: ledgerSizes(dir, names), nudged: false, blocked: false,
  };
  const quiet = entry.nudged === true || freshHandoff(dir, names, entry);
  if (quiet && ctx.entry) return; // the crossing is recorded and said: nothing changed, nothing written
  if (!quiet) entry.nudged = true;
  // Said only once it is RECORDED: a nudge whose `nudged: true` never reached
  // the disk would be said again on the next tool call, and the one after that.
  const recorded = writeState(dir, { set: [id, entry] });
  if (quiet || !recorded) return;
  say(process.stdout, `${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudgeText(m, names) },
  })}\n`);
}

// The SOURCE is named here for the same reason the nudge names it: a percentage
// is only actionable next to the window it is a percentage of, and the two
// messages measure one thing and must explain it the same way.
const blockText = (m, names) => `omelette-fleet: context at ${m.percent}% of ${m.window} tokens (${m.source}) and no \`## Handoff\` `
  + `block has been appended to ${ledgerTarget(names)} since the threshold was crossed. `
  + 'Append it now (state, open findings, agents in flight, next action), then stop.';

/** One session's crossing, dropped. Nothing else in the file is touched, and a state we may not use is left alone. */
function resetHandoff(found, event) {
  if (!found.exists) return;
  const id = str(event.session_id);
  if (!id) return;
  const { state, usable } = readState(found.dir);
  if (!usable || !isObject(state[id])) return;
  writeState(found.dir, { remove: id });
}

/**
 * THE GATE. One turn, once per crossing: `decision: "block"` is the documented
 * way a Stop hook refuses to let a turn end, and the reason reaches the model.
 *
 * Skipped when Claude Code is already continuing because of a stop hook
 * (`stop_hook_active`), inside a sub-agent, and when there is no entry for this
 * session — the threshold was never crossed, and a gate that fires on a session
 * the guard never watched would be a guess.
 *
 * The measurement is RE-TAKEN here: the session may have written the handoff
 * since the nudge, and it may have compacted since the crossing. A fresh block
 * means no block; a context back under the threshold clears the crossing
 * instead of holding a turn for a window that no longer exists.
 *
 * `blocked` is then set and the gate is done. If the session stops again with
 * still no handoff, it stops: this guard reminds, it does not imprison.
 */
function stop(event) {
  if (event.stop_hook_active) return;
  const ctx = handoffContext(event);
  if (!ctx) return;
  const { id, dir, names, entry, m } = ctx;
  if (!entry) return;
  if (m.percent < AUTO_HANDOFF.threshold) { writeState(dir, { remove: id }); return; }
  if (entry.blocked === true) return;
  if (freshHandoff(dir, names, entry)) return;
  entry.blocked = true;
  // Held only once it is RECORDED, for the same reason the nudge is: a gate
  // that could not write `blocked: true` would hold every turn from here on.
  if (!writeState(dir, { set: [id, entry] })) return;
  say(process.stdout, `${JSON.stringify({ decision: 'block', reason: blockText(m, names) })}\n`);
}

const event = await readEvent();
// Wrapped whole: nothing this guard reads — a cwd that is not a directory, a
// ledger that changed under it, a stream that went away — may reach the harness
// as a crash. A PreToolUse refusal is the ONE non-zero exit here, and it has
// already set the code by the time anything can throw.
try {
  if (event) {
    const name = str(event.hook_event_name);
    if (name === 'PreToolUse') preToolUse(event);
    else if (name === 'PreCompact') preCompact(event);
    else if (name === 'SessionStart') sessionStart(event);
    else if (name === 'PostToolUse') postToolUse(event);
    else if (name === 'Stop') stop(event);
    // Anything else: this guard has no opinion about it.
  }
} catch { /* a guard that crashes is a session that stops working */ }
