{{marker}}
/**
 * omelette-fleet :: the guard hook, one script for all three events.
 *
 * WIRED BY THE OPERATOR, NEVER BY US. `omelette-fleet rules --hooks` writes this
 * file and PRINTS the settings.json snippet that calls it; Claude Code's
 * settings.json is read by this package and written by nobody but the operator.
 *
 * PreToolUse (matcher Bash) — the coder's git guard. The operating model says
 * "coder sub-agents never commit"; a settings-level hook is what MAKES it true:
 * the stdin event carries `agent_type` for a sub-agent and nothing for the main
 * thread, so the block lands on the coder and on nothing else. Exit 2 is what
 * stops the call and hands the reason back to that agent.
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
 * IT NEVER THROWS AND IT NEVER BLOCKS ANYTHING ELSE. Malformed stdin, an
 * unknown event, a ledger it may not write, stdin past the cap, stdin that
 * never closes: exit 0. A hook that crashes is a session that stops working,
 * and this one guards exactly one thing.
 *
 * Zero dependencies, Node >= 20, ESM — it is spawned as `node <this file>`.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, writeSync } from 'node:fs';
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
 * What the coder is never allowed to run, whatever it was asked to do — matched
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
 * those may sit anywhere among the arguments (`git rebase -q --abort`):
 * `--abort` is the recovery an agent stuck mid-rebase needs, `--quit` drops the
 * rebase state, and `--help`/`-h` only print. `--continue` and `--skip` each
 * create a commit, and a bare `git rebase` starts one.
 */
const REBASE_READS = new Set(['--abort', '--quit', '--help', '-h']);
const rebaseWrites = (args) => !args.some(({ text, quoted }) => !quoted && REBASE_READS.has(text));

/**
 * Everything the coder may not run, in one question: the comments come off, the
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
const REFUSAL = 'omelette-coder never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead';
const GUARDED_AGENT = 'omelette-coder';
const HANDOFF = 'HANDOFF: re-read .omelette/ledger-*.md before continuing.';

/**
 * Stdin is somebody else's pipe: it can be far bigger than any real event and
 * it can simply never close. Both are answered the same way — stop, and exit 0
 * — because a guard that buffers without bound or waits without end is a
 * session that hangs on every tool call.
 */
const MAX_STDIN = 1024 * 1024; // 1 MiB — orders of magnitude above a real hook event
const STDIN_DEADLINE_MS = 5000;

const str = (v, fallback = '') => (typeof v === 'string' && v ? v : fallback);

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
  if (event.agent_type !== GUARDED_AGENT || event.tool_name !== 'Bash') return;
  if (!forbidden(str(input.command))) return;
  // exitCode, not exit(): the process leaves on its own once stderr is flushed.
  // Set first, so a stderr that cannot be written to still refuses the call.
  process.exitCode = 2;
  say(process.stderr, `${REFUSAL}\n`);
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
  let ledgers = [];
  try { ledgers = found.exists ? readdirSync(found.dir).filter((f) => /^ledger-.*\.md$/.test(f)).sort() : []; } catch { ledgers = []; }
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
      fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW);
      writeSync(fd, line);
    } catch { /* ignore */ } finally {
      if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
    }
  }
  say(process.stdout, `${HANDOFF}\n`);
}

/** A level-2 heading, and the one that opens a handoff block. `### Handoff` is neither. */
const HEADING = /^##\s/;
const HANDOFF_HEADING = /^##\s+handoff/i;

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
  let ledgers = [];
  try { ledgers = readdirSync(found.dir).filter((f) => /^ledger-.*\.md$/.test(f)).sort(); } catch { return; }
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
      const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
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
    // Anything else: this guard has no opinion about it.
  }
} catch { /* a guard that crashes is a session that stops working */ }
