{{marker}}
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
 * `git tag` flags that WRITE a tag: annotate (`-a`), sign (`-s`, `-u <key>`),
 * force (`-f`), delete (`-d`), and the three that supply or groom a message and
 * so imply `-a` — `-m`, `-F`/`--file` and `--cleanup`. Its listing flags —
 * `-l`, `--list`, `-n`, `--contains`, `--sort` — are reads and are not here.
 */
const TAG_WRITES = '-[adFfmsu]|--annotate|--cleanup|--delete|--file|--force|--message|--sign|--local-user';

/**
 * What the coder is never allowed to run, whatever it was asked to do — matched
 * against real git syntax rather than its tidiest form:
 *   - a longer subcommand that merely starts like a forbidden one is NOT this:
 *     `git commit-tree` writes an object and commits nothing, and `merge-base`
 *     only computes — hence `(?![\w-])` on the bare subcommands;
 *   - `git branch` READS (listing, `-d`, `-a`, `-r`, `-v`) until it is handed a
 *     name to create or a flag that moves a ref (BRANCH_WRITES);
 *   - `git tag` is the same shape: listing tags is how an agent finds the last
 *     release, so it reads until it is handed a name or a TAG_WRITES flag;
 *   - `git rebase` writes in every form but ONE: `--abort` undoes a rebase and
 *     is the recovery an agent stuck mid-rebase needs (`--continue` and
 *     `--skip` create commits, and a bare `git rebase` starts one);
 *   - and the branch-creating flags of `checkout`/`switch` may come after other
 *     flags and arguments (`checkout -q -b feat`) or with the name attached to
 *     them (`checkout -bfeat`, and `-B`/`-C` force it), so the scan runs to the
 *     end of the command rather than looking only at the next word. `[^\s;&|]`
 *     keeps that scan inside ONE command instead of crossing `;`, `&&` or `|`.
 *
 * NOT a security boundary: this is containment for a delegated agent that is
 * asked to behave, so an argv-array spawn, a backslash-escaped `g\it`, an alias
 * or `$(which git)` are deliberately out of scope. See docs/SECURITY.md.
 */
const FORBIDDEN = new RegExp(
  `\\bgit${OPTION_RUN}\\s+(?:(?:${WRITES_HISTORY})(?![\\w-])`
  + '|rebase(?![\\w-])(?!\\s+--abort(?![\\w-]))'
  + '|branch(?![\\w-])\\s+(?!-)\\S'
  + `|branch(?![\\w-])(?:\\s+[^\\s;&|]+)*?\\s+(?:${BRANCH_WRITES})`
  + '|tag(?![\\w-])\\s+(?!-)\\S'
  + `|tag(?![\\w-])(?:\\s+[^\\s;&|]+)*?\\s+(?:${TAG_WRITES})`
  + '|checkout(?:\\s+[^\\s;&|]+)*?\\s+(?:-[bB]|--orphan|--track)'
  + '|switch(?:\\s+[^\\s;&|]+)*?\\s+(?:-[cC]|--create|--force-create)'
  + ')',
);
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
  if (!FORBIDDEN.test(str(input.command))) return;
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
