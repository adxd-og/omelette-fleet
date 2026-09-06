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
 * unknown event, a ledger it may not write: exit 0. A hook that crashes is a
 * session that stops working, and this one guards exactly one thing.
 *
 * Zero dependencies, Node >= 20, ESM — it is spawned as `node <this file>`.
 */
import { appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the coder is never allowed to run, whatever it was asked to do — matched
 * against real git syntax rather than its tidiest form:
 *   - global flags come first often enough to matter: `git -C <dir> commit`,
 *     `git -c user.name=x commit`, `git --no-pager push`;
 *   - a branch name may be attached to its flag — `checkout -bfeat` and
 *     `switch -cfeat` create a branch exactly like the spaced form — and `-B`/`-C`
 *     do it forcibly, so the flag ENDS the match instead of being read as a word;
 *   - and a longer subcommand that merely starts like one is NOT this:
 *     `git commit-tree` writes an object and commits nothing, hence `(?![\w-])`
 *     on the bare subcommands only.
 */
const FORBIDDEN = /\bgit(?:\s+-[cC]\s*\S+|\s+--[\w-]+(?:=\S+)?)*\s+(?:(?:commit|push|stash|worktree)(?![\w-])|checkout\s+-[bB]|switch\s+-[cC])/;
const REFUSAL = 'omelette-coder never commits, pushes, stashes, branches or opens worktrees; report instead';
const GUARDED_AGENT = 'omelette-coder';
const HANDOFF = 'HANDOFF: re-read .omelette/ledger-*.md before continuing.';

const str = (v, fallback = '') => (typeof v === 'string' && v ? v : fallback);

/** The whole event, or null: stdin that never arrives or never parses is not an error here. */
async function readEvent() {
  let raw = '';
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    raw = Buffer.concat(chunks).toString('utf8');
  } catch { return null; }
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
    // A ledger we cannot write is not a reason to fail somebody's compaction.
    try { appendFileSync(join(dir, name), line); } catch { /* ignore */ }
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
