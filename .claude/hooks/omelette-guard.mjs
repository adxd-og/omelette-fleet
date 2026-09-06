// omelette-fleet hook v0.3.2 · managed by `omelette-fleet rules --hooks` · edits are overwritten on refresh
/**
 * omelette-fleet :: the guard hook, one script for both events.
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
 * IT NEVER THROWS AND IT NEVER BLOCKS ANYTHING ELSE. Malformed stdin, an
 * unknown event, a ledger it may not write, stdin past the cap, stdin that
 * never closes: exit 0. A hook that crashes is a session that stops working,
 * and this one guards exactly one thing.
 *
 * Zero dependencies, Node >= 20, ESM — it is spawned as `node <this file>`.
 */
import { appendFileSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

/** Exit 2 = "do not run this", with the reason on stderr for the agent to read. */
function preToolUse(event) {
  const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
  if (event.agent_type !== GUARDED_AGENT || event.tool_name !== 'Bash') return;
  if (!forbidden(str(input.command))) return;
  process.stderr.write(`${REFUSAL}\n`);
  // exitCode, not exit(): the process leaves on its own once stderr is flushed.
  process.exitCode = 2;
}

/** Mark every ledger in this project, then say so on stdout. */
function preCompact(event) {
  const dir = join(str(event.cwd, process.cwd()), '.omelette');
  const line = `\n## Compaction ${new Date().toISOString()} (trigger: ${str(event.trigger, 'unknown')}) — re-read this ledger before continuing\n`;
  let ledgers = [];
  try { ledgers = readdirSync(dir).filter((f) => /^ledger-.*\.md$/.test(f)).sort(); } catch { ledgers = []; }
  for (const name of ledgers) {
    // A ledger we cannot write is not a reason to fail somebody's compaction —
    // and one that is not a REGULAR file is not a ledger at all: lstat (never
    // stat) so a symlink is seen as a symlink and skipped instead of followed
    // out of .omelette, and a FIFO named like a ledger is skipped instead of
    // blocking the append until somebody opens the other end.
    try {
      if (!lstatSync(join(dir, name)).isFile()) continue;
      appendFileSync(join(dir, name), line);
    } catch { /* ignore */ }
  }
  process.stdout.write(`${HANDOFF}\n`);
}

const event = await readEvent();
if (event) {
  const name = str(event.hook_event_name);
  if (name === 'PreToolUse') preToolUse(event);
  else if (name === 'PreCompact') preCompact(event);
  // Anything else: this guard has no opinion about it.
}
