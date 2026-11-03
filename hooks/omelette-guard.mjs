{{marker}}
/**
 * omelette-fleet :: the guard hook, one script for four events.
 *
 * WIRED BY THE OPERATOR, NEVER BY US. `omelette-fleet rules --hooks` writes this
 * file and PRINTS the settings.json snippet that calls it; Claude Code's
 * settings.json is read by this package and written by nobody but the operator.
 *
 * PreToolUse (matcher Bash) — the git guard on the sub-agent roles this package
 * ships. The operating model says "coder sub-agents never commit" and asks the
 * same of the tester, which reports what it saw rather than moving the tree, and
 * of the reviewer, which reads and writes one report; a settings-level hook is
 * what MAKES that true for git: the stdin event carries `agent_type` for a
 * sub-agent and nothing for the main thread, so the block lands on
 * omelette-coder, omelette-coder-medium, omelette-tester and omelette-reviewer
 * and on nothing else.
 * Exit 2 is what stops the call, and the reason it hands back names the agent
 * it caught.
 *
 * PreToolUse (Bash and Write, every agent and the main thread) — the curated
 * files (1.8.0): a ledger, the backlog and the decisions register are appended
 * to, never rewritten. A Bash command that truncates one and a Write that is not
 * an append to one are refused, naming the file; see CURATED below.
 *
 * PreCompact — the ledger's re-read stamp. A compaction is where a plan loses
 * its context, so the guard runs the ledger sweep, then stamps every
 * `.omelette/ledger-*.md` left open or untracked with a line saying it must be
 * re-read, and the handoff reminder goes to stdout for the harness to pass on if
 * it does. A ledger the sweep found closed is finished work — archived, or held
 * in place by a collision — and nobody re-reads it.
 *
 * SessionStart — runs the ledger sweep on every source, so a ledger whose
 * branch is gone is archived before a session reads it. Then, on `compact` and
 * `clear`, the other half, and the half that is PROMISED: Claude Code's hooks
 * reference says a SessionStart hook's stdout is added to the session's
 * context, where PreCompact's is documented nowhere. Those two sources lost the
 * context; a startup, a resume and a fork did not, and print nothing. The print
 * is three sections, bounded, in the order of the three questions a fresh
 * context asks: where the work stands (the last handoff block of each open
 * ledger, then of each untracked one), what was decided (the decisions
 * register), and what comes next (the first table of `.omelette/backlog.md`).
 *
 * SubagentStop (1.8.0) — the touched record: when a guarded role stops, the
 * paths it wrote, read out of its own transcript, go to
 * `.omelette/reports/touched-<role>-<id>.md`; see subagentStop below. Nothing
 * is refused and nothing is printed.
 *
 * THE SWEEP IS THE ONE THING THIS GUARD LOADS FROM OUTSIDE ITSELF:
 * `core/ledger.mjs`, imported from the package root `rules --hooks` rendered
 * into PACKAGE_ROOT below. A failed import is one stderr line, and the stamp and
 * the print go on without the sweep; what this guard refuses and what it prints
 * stay in this file. PreToolUse loads it for one value only, the register's
 * path (readRegisterPath), and without it curates `.omelette/decisions.md`.
 *
 * The two ledger hooks answer to one switch, `handoff.enabled`, rendered into
 * this script as a literal (HANDOFF_CONFIG below): false turns the sweep, the
 * stamp and the print off, and the git guard runs whatever it says.
 *
 * PostToolUse, Stop and PostCompact — RETIRED in 1.5.0. From 0.3.4 to 1.4.0
 * this script also measured the context and nudged, held one turn until a
 * handoff was written, and appended each compaction's summary to the ledger;
 * over five compactions none of it rescued anything the session had not
 * written itself (docs/MEASUREMENTS.md). A settings.json that still calls the
 * guard on one of them gets what any other event gets: no opinion, exit 0,
 * nothing said and nothing written. `doctor` names such an entry so the
 * operator can remove it.
 *
 * IT NEVER THROWS AND IT NEVER BLOCKS ANYTHING ELSE. Malformed stdin, an
 * unknown event, a ledger it may not write, stdin past the cap, stdin that
 * never closes: exit 0. A hook that crashes is a session that stops working,
 * and this one guards exactly one thing.
 *
 * Zero dependencies, Node >= 20, ESM — it is spawned as `node <this file>`.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter as PATH_DELIMITER, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

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
 * What a guarded role is never allowed to run, whatever it was asked to do: a
 * `git` invocation that writes history, a ref, a stash or a worktree. Matched
 * against real git syntax rather than its tidiest form, and read the way the
 * shell reads the command — the comments come off (withoutComments), the rest
 * becomes words, separators, redirections and command and process substitutions
 * in one pass (tokenize), and every `git … <subcommand>` in those words is found
 * with its own arguments (invocations). Then:
 *   - a subcommand in WRITES_HISTORY writes, whatever follows it;
 *   - `branch`, `checkout`, `switch`, `tag`, `rebase`, `reset` and
 *     `symbolic-ref` are read by their ARGUMENTS, because a flag or a name
 *     among them decides what they do — see WRITES_BY_ARGUMENTS below;
 *   - and a longer subcommand that merely starts like one of these is NOT it:
 *     `git commit-tree` writes an object and commits nothing, and `merge-base`
 *     only computes — hence the `(?![\w-])` in SUBCOMMAND.
 *
 * NOT a security boundary: this is containment for a delegated agent that is
 * asked to behave, so an argv-array spawn, a backslash-escaped `g\it`, an alias
 * or `$(which git)` are deliberately out of scope. See docs/SECURITY.md.
 */

/**
 * Subcommands that create a commit, move a stash or a worktree, or set or delete
 * a ref by hand (`update-ref`, `-d` included) — nothing after them makes them
 * read-only.
 */
const WRITES_HISTORY = new Set(['commit', 'merge', 'cherry-pick', 'revert', 'am', 'pull', 'push', 'stash', 'worktree', 'update-ref']);

/**
 * The options git accepts BEFORE the subcommand, one word each. GLOBAL_VALUED
 * may take the NEXT word as its value: `-c`/`-C` (`-C "/My Dir"`, `-c
 * user.name="A B"`) and a long flag (`--work-tree /tmp/x`) — whatever that
 * word opens with, as git takes it (`git -C -foo commit`). GLOBAL_FLAG needs nothing
 * after it: `-c`/`-C` with the value attached (`-cuser.name=a`, `-C/x`), a long
 * flag with its value attached by `=`, a value-less short flag (`-p`) and the
 * bare `--` separator. Everything in the run is stepped over on the way to the
 * subcommand, so no amount of prefixing hides one.
 *
 * GLOBAL_NO_VALUE are the long options git itself reads WITHOUT a value, so the
 * word behind one is never its value: `git --no-pager checkout -b tag/v1` checks
 * out, and creates `tag/v1`. A long option on neither list may take one.
 */
const GLOBAL_VALUED = /^(?:-[cC]|--[\w-]+)$/;
const GLOBAL_FLAG = /^(?:--|-[A-Za-z]|-[cC].+|--[\w-]+=.+)$/s;
const GLOBAL_NO_VALUE = new Set([
  '--bare', '--exec-path', '--glob-pathspecs', '--html-path', '--icase-pathspecs', '--info-path',
  '--literal-pathspecs', '--man-path', '--no-advice', '--no-lazy-fetch', '--no-optional-locks', '--no-pager',
  '--no-replace-objects', '--noglob-pathspecs', '--paginate',
]);

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

/** The redirections that write their target, and the two of them that only append to it. */
const WRITE_REDIRECTS = new Set(['>', '>|', '>>', '<>', '&>', '&>>']);
const APPEND_REDIRECTS = new Set(['>>', '&>>']);
/** The word after `>&` that duplicates or closes a descriptor rather than naming a file: digits or `-`, and the `)` of a subshell the word ends in. */
const FD_DUPLICATE = /^(?:\d+|-)\)*$/;

/**
 * Where the substitution opened at `start` — `$(`, `<(`, `>(` or a backquote —
 * ends: the index of its closing `)` or backquote, or the command's length when
 * it never closes. A parenthesised one nests, so its parentheses are counted,
 * outside quotes; a backquoted one ends at the next backquote that no backslash
 * escapes.
 */
function substitutionEnd(command, start) {
  if (command[start] === '`') {
    for (let j = start + 1; j < command.length; j++) {
      if (command[j] === '\\') j++;
      else if (command[j] === '`') return j;
    }
    return command.length;
  }
  let depth = 0;
  let quote = '';
  for (let j = start + 1; j < command.length; j++) {
    const c = command[j];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return command.length;
}

/**
 * The delimiter word of a `<<` or `<<-` whose operator ends just before `from`:
 * `{ raw, word, quoted, end }` — the word as written, the word with its quotes
 * and backslashes off, whether any were there (a quoted delimiter makes the body
 * literal), and the index just past it — or null when no word follows on the line.
 */
function heredocDelimiter(command, from) {
  let i = from;
  while (command[i] === ' ' || command[i] === '\t') i++;
  const start = i;
  let word = '';
  let quoted = false;
  let quote = '';
  for (; i < command.length; i++) {
    const c = command[i];
    if (quote) { if (c === quote) quote = ''; else word += c; continue; }
    if (c === '"' || c === "'") { quote = c; quoted = true; continue; }
    if (c === '\\' && i + 1 < command.length) { quoted = true; word += command[++i]; continue; }
    if (/\s/.test(c) || ';&|<>()'.includes(c)) break;
    word += c;
  }
  return i > start ? { raw: command.slice(start, i), word, quoted, end: i } : null;
}

/**
 * HEREDOC BODIES ARE TEXT. From `pos` — just past the newline that ends the
 * operator's line — each pending heredoc, in order, takes the lines up to the
 * one that IS its word (after leading tabs for `<<-`): `EOF text` or `  EOF` is
 * body, and a body that never terminates runs to the end. An unquoted body still
 * expands `$(…)` and backquotes, so what those run is handed back in `spans`.
 *
 * @returns {number} the index just past the last terminator line
 */
function skipHeredocBodies(command, pos, heredocs, spans) {
  for (const { word, quoted, stripTabs } of heredocs) {
    let body = '';
    while (pos < command.length) {
      // In an unquoted body, a line ending in an odd run of backslashes goes on
      // into the next one, the backslash and newline dropped: `EO\` + `F` is `EOF`.
      // The run is counted within each physical line: what is kept of the line
      // before is an even run, pairs that are already complete.
      let line = '';
      for (;;) {
        const newline = command.indexOf('\n', pos);
        const lineEnd = newline < 0 ? command.length : newline;
        let run = 0;
        while (lineEnd - run > pos && command[lineEnd - run - 1] === '\\') run++;
        line += command.slice(pos, lineEnd);
        pos = Math.min(lineEnd + 1, command.length);
        if (quoted || newline < 0 || run % 2 === 0) break;
        line = line.slice(0, -1);
      }
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === word) break;
      if (!quoted) body += `${line}\n`;
    }
    if (quoted) continue;
    for (let k = 0; k < body.length; k++) {
      if (body[k] === '\\') { k++; continue; } // `\$(` and `` \` `` are literal in a body
      if (!((body[k] === '$' && body[k + 1] === '(') || body[k] === '`')) continue;
      const end = substitutionEnd(body, k);
      spans.push(body.slice(k + (body[k] === '`' ? 1 : 2), end));
      k = end;
    }
  }
  return pos;
}

/**
 * WHERE THE SHELL READS NO REDIRECTION. The index of the last character of the
 * region opened at `start`, or -1 when it is not one: `((` — arithmetic, only
 * when its matching close is `))`, else nested subshells (`((git commit); x)`);
 * `{` — a `${…}`, to its matching `}`; `[` — a subscript inside a word, to its
 * `]`, and not one when an unquoted blank or separator comes first. A region
 * that never closes is not one, so the rest of the command is read as before.
 * Quotes, backslashes and substitutions are skipped, so a `)` or `}` inside them
 * closes nothing.
 *
 * ONE BUDGET PER COMMAND. Every call made for one tokenize shares `budget`, the
 * characters left to examine: `a[a[a[…` unclosed would otherwise scan to the end
 * from every opener — quadratic, 120 KB took 73.5 s against the hook's 150 s
 * timeout. A closed region scans only to its close, so a real command never
 * spends it; one that does is refused whole (`exhausted`, TOO_DEEP), because
 * any reading past that point would be a second parser to prove against bash.
 */
const OPAQUE_SCAN_BUDGET = 1 << 20;

function opaqueEnd(command, start, kind, budget) {
  const [open, close] = kind === '{' ? '{}' : kind === '[' ? '[]' : '()';
  let depth = 0;
  let quote = '';
  for (let j = start; j < command.length; j++) {
    if (--budget.left < 0) return -1;
    const c = command[j];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '\\') { j++; continue; }
    if ((c === '$' && command[j + 1] === '(') || c === '`') {
      const end = substitutionEnd(command, j);
      budget.left -= end - j;
      j = end;
      continue;
    }
    if (kind === '[' && (/\s/.test(c) || SEPARATORS.has(c))) return -1;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (kind === '((' && depth === 1) return command[j + 1] === ')' ? j + 1 : -1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/**
 * The whole command as WORDS and SEPARATORS, in one left-to-right pass. A quoted
 * span is opaque — the whitespace, the `;` and the `>` inside it belong to the
 * value, and a word that OPENS with a quote is a value rather than a flag, so
 * `--exec 'echo --abort now'` is a rebase that runs a command and not a rebase
 * that aborts. Every word that holds a quote is handed back too, as the shell
 * passes it on — quotes off and its pieces JOINED, so `'git tag '"v1"` is the
 * one word `git tag v1` — because `sh -c 'git commit'` runs that word, and
 * forbidden reads it again as a command.
 *
 * A COMMAND SUBSTITUTION IS A COMMAND OF ITS OWN. An unquoted `$(…)` or
 * backquoted one is part of ONE word of the command around it — in the word it
 * stands as its bare delimiters, `$()` — and what it runs is handed back to be
 * read as a command. So `git checkout $(git tag -l v1) -b new` is a checkout
 * whose start point comes from a listing, and `-b new` is the checkout's; `git
 * -C $(git rev-parse --show-toplevel) commit` commits. What a substitution
 * PRINTS is not known here and is not guessed at: it is one word, no flag. A
 * process substitution, `<(…)` or `>(…)`, is read exactly the same way — `diff
 * <(git tag -l) <(git branch -l)` is a diff of two listings — and so is one in
 * a redirection's target: `echo x > >(git commit -m y)` commits.
 *
 * A REDIRECTION IS THE SHELL'S. An unquoted `<`, `>`, `>>`, `>|`, `<>`, `&>`,
 * `&>>`, `>&`, `<&`, `<<`, `<<-` or `<<<` ends the word before it, takes a
 * leading fd number with it (`2>`, `2>&1`), and makes the next word — attached
 * (`>--abort`) or after a space — its TARGET. git sees neither, so a target is
 * no word at all: `git tag t > --list` creates `t`, and `git tag > tags.txt`
 * lists. A substitution or a quoted word inside a target is still handed back
 * (`> $(git tag v1)`, `< <(git commit)`, and a `(` right behind the operator,
 * `>>(git push)`): the word goes, what it runs does not.
 *
 * A TARGET THAT IS A FILE is handed back too, in `targets`, for the curated
 * rule (bashWrites): its path with the quotes off, its operator without the fd
 * number (`2>` is `>`), and `at`, the number of words before it — which is how
 * a `cd` word is known to come first. `>&` with a word that is not an fd number
 * or `-` sends both streams to that file, and is handed back as the `&>` it is;
 * an fd number or `-` with a subshell's closing `)` glued on (`(ls > a 2>&1)`)
 * duplicates a descriptor and is no target (FD_DUPLICATE).
 *
 * @returns {object} `{ tokens, spans, targets }`: each token `{ text, quoted,
 *   separator }`, each span a text to read again as a command — a quoted word
 *   with its quotes off, or what a command or process substitution runs — each
 *   target `{ path, op, at }` with `op` one of WRITE_REDIRECTS; plus `exhausted:
 *   true`, and nothing read past that point, when the brackets spent
 *   OPAQUE_SCAN_BUDGET
 */
function tokenize(command) {
  const tokens = [];
  const spans = [];
  const targets = [];
  let text = '';
  let quoted = false;
  let quote = '';
  let redirect = false; // the next word is a redirection's target
  let redirectOp = ''; //  …of this operator
  const pendingHeredocs = []; // `<<`/`<<-` read on this line, their bodies start at the next newline
  const budget = { left: OPAQUE_SCAN_BUDGET }; // shared by every opaqueEnd this command makes
  const push = () => {
    if (!text) return;
    const plain = unquote(text); // only a word that held a quote loses a character here
    if (!redirect) tokens.push({ text, quoted, separator: false });
    else {
      const op = redirectOp === '>&' && !FD_DUPLICATE.test(plain) ? '&>' : redirectOp;
      if (WRITE_REDIRECTS.has(op)) targets.push({ path: plain, op, at: tokens.length });
    }
    if (plain !== text) spans.push(plain);
    text = '';
    quoted = false;
    redirect = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = '';
      text += c;
      continue;
    }
    if (c === '"' || c === "'") { quoted = quoted || !text; text += c; quote = c; continue; }
    const next = command[i + 1] ?? '';
    let opaque = -1;
    if (c === '(' && next === '(' && !text) opaque = opaqueEnd(command, i, '((', budget);
    else if (c === '$' && next === '{') opaque = opaqueEnd(command, i + 1, '{', budget);
    else if (c === '[' && text) opaque = opaqueEnd(command, i, '[', budget);
    if (budget.left < 0) return { tokens, spans, targets, exhausted: true }; // no partial reading: refused whole
    if (opaque >= 0) {
      // Part of the word, `<<` and all; only its substitutions are commands.
      let inner = '';
      for (let k = i; k <= opaque; k++) {
        const ch = command[k];
        if (inner) { if (ch === inner) inner = ''; text += ch; continue; }
        if (ch === '"' || ch === "'") { inner = ch; text += ch; continue; }
        if (ch === '\\') { text += command.slice(k, k + 2); k++; continue; }
        if ((ch === '$' && command[k + 1] === '(') || ch === '`') {
          const end = substitutionEnd(command, k);
          spans.push(command.slice(k + (ch === '`' ? 1 : 2), end));
          text += ch === '`' ? '``' : '$()';
          k = end;
          continue;
        }
        text += ch;
      }
      i = opaque;
      continue;
    }
    if (((c === '$' || c === '<' || c === '>') && next === '(') || c === '`') {
      const end = substitutionEnd(command, i);
      const open = c === '`' ? '`' : `${c}(`;
      spans.push(command.slice(i + open.length, end));
      // Its bare delimiters, never longer than what they stand for, so a word
      // read again is never longer than the one it came from.
      text += end < command.length ? `${open}${c === '`' ? '`' : ')'}` : open;
      i = end;
      continue;
    }
    if (c === '<' || c === '>' || (c === '&' && next === '>')) {
      if (/^\d+$/.test(text)) text = ''; else push(); // `2>`: the fd number is part of the operator
      const opAt = i;
      if (c === '&') i++; //                             `&>`, `&>>`: the `>` comes next
      const follows = (chars) => i + 1 < command.length && chars.includes(command[i + 1]);
      let heredoc = false;
      if (command[i] === '>' && follows('>|&')) i++; //                     `>>`, `>|`, `>&`
      else if (command[i] === '<' && follows('<')) { // `<<`, `<<<`, `<<-`
        i++;
        heredoc = !follows('<(');
        if (follows('<-')) i++;
      } else if (command[i] === '<' && follows('>&')) i++; //               `<>`, `<&`
      redirect = true;
      redirectOp = command.slice(opAt, i + 1);
      if (heredoc) {
        const delimiter = heredocDelimiter(command, i + 1);
        if (delimiter) {
          pendingHeredocs.push({ word: delimiter.word, quoted: delimiter.quoted, stripTabs: command[i] === '-' });
          text = delimiter.raw;
          push();
          i = delimiter.end - 1;
        }
        continue;
      }
      if (follows('(')) {
        // A `(` right behind the operator — `>>(…)`, `2>>(…)`, `<<(…)`, `&>>(…)`,
        // `>|(…)` — is a process substitution as the target: zsh runs what is
        // inside it. Read as `>(…)` is above: the target word goes (its bare
        // `()`), what it runs is handed back.
        const end = substitutionEnd(command, i);
        spans.push(command.slice(i + 2, end));
        text += end < command.length ? '()' : '(';
        i = end;
      }
      continue;
    }
    if (SEPARATORS.has(c)) {
      push();
      redirect = false;
      tokens.push({ text: c, quoted: false, separator: true });
      if (c === '\n' && pendingHeredocs.length) {
        i = skipHeredocBodies(command, i + 1, pendingHeredocs.splice(0), spans) - 1;
      }
      continue;
    }
    if (/\s/.test(c)) { push(); continue; }
    text += c;
  }
  push(); // a quote the command never closed runs to its end, inside the last word
  return { tokens, spans, targets };
}

/**
 * A word that ends in `git` where a word begins — `git`, `/usr/bin/git`, `(git` — which is where an invocation can start.
 * Read with its quotes off: `"git"` and `g'it'` are the word git runs as.
 */
const isGitWord = ({ text, separator }) => {
  if (separator) return false;
  const word = unquote(text);
  return word.endsWith('git') && !/\w/.test(word.charAt(word.length - 4));
};

/** A word that runs `xargs`, which hands the command after it arguments this command does not show. */
const isXargsWord = ({ text, separator }) => !separator && /(?:^|\/)xargs$/.test(unquote(text));

/**
 * The subcommand of the `git` word at `at`, as `{ name, from }` — `from` is the
 * index its arguments start at — or null when the words after it name none.
 *
 * A SPACED VALUE MAY BE THE SUBCOMMAND INSTEAD, behind a value-less option this
 * guard has not heard of (`git --no-newflag commit`). So when the run ends on a
 * word that names no subcommand, the LAST value that names one is the
 * subcommand, and its arguments start right behind it — `git -c commit` is
 * refused, as the regex before 1.3.0 refused it.
 *
 * THE RUN STOPS AT A `git` WORD, even one in a value position (`git -c git …`):
 * that word is read as an invocation of its own from the same place, so no
 * subcommand behind it is missed, and no word is walked by two runs. Until
 * 1.3.0 a regex walked the run again from every `git` word inside it: `git -c `
 * ×4 000 took 2.4 s, and ×16 000 before a `; git commit` 8.9 s.
 */
function subcommandAt(tokens, at) {
  let j = at + 1;
  let fallback = -1;
  const isWord = () => j < tokens.length && !tokens[j].separator && !isGitWord(tokens[j]);
  while (isWord()) {
    // Options and their values are read with the quotes off too: `git "-C" /x commit` is `git -C /x commit`.
    const text = unquote(tokens[j].text);
    if (GLOBAL_VALUED.test(text) && !GLOBAL_NO_VALUE.has(text)) {
      j++;
      // git takes the next word as the value whatever it opens with: `git -C -foo commit`.
      if (isWord()) {
        if (SUBCOMMAND.test(unquote(tokens[j].text))) fallback = j;
        j++;
      }
    } else if (GLOBAL_FLAG.test(text) || GLOBAL_NO_VALUE.has(text)) j++;
    else break;
  }
  // The subcommand is read with its quotes off, as git receives it: `git "commit"`, `git co"mm"it`.
  const sub = isWord() ? SUBCOMMAND.exec(unquote(tokens[j].text)) : null;
  if (sub) return { name: sub[1], from: j + 1 };
  return fallback < 0 ? null : { name: SUBCOMMAND.exec(unquote(tokens[fallback].text))[1], from: fallback + 1 };
}

/**
 * Every `git … <subcommand>` in the words, each with its ARGUMENTS: the words
 * after the subcommand, up to the next separator. A `git` word with no
 * subcommand behind it (`git tag x-git`) is an argument like any other. One that
 * starts an invocation of its own is too, and so is everything up to and
 * including ITS subcommand — git hands those words to the first invocation
 * (`git checkout git -b tag` creates `tag` from a ref called `git`) — but the
 * words after that subcommand are the new invocation's alone.
 *
 * An invocation behind an `xargs` word in the same command is marked `xargs`:
 * the arguments that decide it arrive on xargs' input, not in the command.
 *
 * That cut is what keeps the whole scan linear in the command's length however
 * many invocations it holds: every word is read at most twice, once by a
 * subcommandAt run and once here. Until 1.3.0 each invocation copied every word
 * up to the next separator, and 32 000 of them in one command ran V8 out of heap
 * before the refusal was written. One thing it costs: `git tag git tag -l`,
 * which git reads as one listing, is refused as a tag called `git`.
 */
function invocations(tokens) {
  const calls = [];
  let call = null; //    the invocation whose arguments are being collected
  let xargs = false; //  an `xargs` word earlier in this command
  const collect = (from, to) => {
    for (let k = from; k < to; k++) if (call) call.args.push(tokens[k]);
  };
  for (let i = 0; i < tokens.length;) {
    if (tokens[i].separator) { call = null; xargs = false; i++; continue; }
    const found = isGitWord(tokens[i]) ? subcommandAt(tokens, i) : null;
    if (!found) { xargs = xargs || isXargsWord(tokens[i]); collect(i, i + 1); i++; continue; }
    collect(i, found.from); // the `git` word, its options and its subcommand
    call = { name: found.name, args: [], xargs };
    calls.push(call);
    i = found.from;
  }
  return calls;
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
 * hide a real name. Nor are `--column` and `--color`, for the same reason: git
 * takes their value attached only (`--column=always`), so `git tag --column
 * always` creates a tag called `always` — measured on git 2.38.1.
 */
const TAG_VALUE_SHORT = new Set([...'mFu']);
const TAG_VALUE_LONG = new Set([
  '--cleanup', '--contains', '--format', '--local-user',
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
 *
 * The git word and the subcommand, by contrast, are read unquoted (isGitWord,
 * subcommandAt): quoting them changes nothing about what runs, so quotes there
 * hide nothing. The action flags are not, because for them quoting is the one
 * way a command says a word is data, and reading them unquoted would let a
 * quoted `--abort` pass a rebase that writes.
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
 * `git branch` CREATES a branch whenever it is handed a name and no mode that
 * takes an existing one: a listing (`-l`/`--list`, or a filter that implies one —
 * `--contains`, `--no-contains`, `--merged`, `--no-merged`, `--points-at`), a
 * delete (`-d`/`-D`/`--delete`), `--show-current`, `--edit-description` or
 * `--unset-upstream`. Every other flag leaves a name a name — `-q`, `-v`, `-t`,
 * `--no-track`, `--create-reflog`, one git has never heard of — and so does a
 * bare `--`: measured on git 2.38.1, `git branch -v x` and `git branch -- x`
 * each create `x`. A branch that exists MOVES under rename (`-m`/`-M`/`--move`),
 * copy (`-c`/`-C`/`--copy`), force-reset (`-f`/`--force`) or a new upstream
 * (`-u`/`--set-upstream-to`), whatever mode sits beside them.
 */
const BRANCH_WRITE_SHORT = new Set([...'cCfmMu']);
const BRANCH_WRITE_LONG = new Set(['--copy', '--force', '--move', '--set-upstream-to']);
const BRANCH_MODE_SHORT = new Set([...'dDl']);
const BRANCH_MODE_LONG = new Set([
  '--contains', '--delete', '--edit-description', '--list', '--merged', '--no-contains', '--no-merged',
  '--points-at', '--show-current', '--unset-upstream',
]);

/**
 * …and the options whose value may arrive as the NEXT WORD, which is then never
 * a name: `git branch --sort refname x` creates `x` and nothing called
 * `refname`. `--color`, `--column` and `--abbrev` are not here — git takes
 * their value attached only, as it does for `tag`, so the word behind one of
 * them is a name.
 */
const BRANCH_VALUE_SHORT = new Set([...'u']);
const BRANCH_VALUE_LONG = new Set(['--contains', '--format', '--merged', '--no-contains', '--no-merged', '--points-at', '--set-upstream-to', '--sort']);

/**
 * Does this `git branch` write? Read the way tagWrites reads a tag — a write flag
 * always does, and otherwise a name does unless a mode took it — except that
 * the quotes come off every word first (unquote), as they do in rebaseWrites,
 * because the shell hands git `-m` for `"-m"`. A short run is a cluster (`-qm`
 * is `-q -m`), and `-u` ends it: the rest of the word is its value, and sitting
 * last it takes the next word.
 */
function branchWrites(args) {
  let write = false;
  let mode = false;
  let names = false;
  let afterSeparator = false;
  let takesValue = false;
  for (const { text } of args) {
    if (takesValue) { takesValue = false; continue; } // the previous option's value
    const token = unquote(text);
    if (afterSeparator || token === '-' || !token.startsWith('-')) { names = true; continue; }
    if (token === '--') { afterSeparator = true; continue; }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq < 0 ? token : token.slice(0, eq);
      if (BRANCH_WRITE_LONG.has(name)) write = true;
      else if (BRANCH_MODE_LONG.has(name)) mode = true;
      if (eq < 0 && BRANCH_VALUE_LONG.has(name)) takesValue = true;
      continue;
    }
    for (let k = 1; k < token.length; k++) {
      const ch = token[k];
      if (BRANCH_WRITE_SHORT.has(ch)) write = true;
      else if (BRANCH_MODE_SHORT.has(ch)) mode = true;
      if (BRANCH_VALUE_SHORT.has(ch)) { takesValue = k === token.length - 1; break; }
    }
  }
  return write || (names && !mode);
}

/**
 * `git checkout` and `git switch` create a branch only by a FLAG: `-b`/`-B`,
 * `--orphan` and `-t`/`--track` for checkout (`-t origin/feat` creates `feat`);
 * `-c`/`-C`, `--create`, `--force-create`, `--orphan` and `-t`/`--track` for
 * switch.
 */
const CHECKOUT_CREATES = { short: new Set([...'bBt']), long: new Set(['--orphan', '--track']) };
const SWITCH_CREATES = { short: new Set([...'cCt']), long: new Set(['--create', '--force-create', '--orphan', '--track']) };

/**
 * Does this `git checkout` / `git switch` create a branch? The flag counts
 * wherever it sits (`checkout -q -b feat`), inside a short cluster (`-qb`), with
 * the name attached (`-bfeat`), with a value after `=` (`--track=direct`) and
 * quoted (`"-b"` reaches git as `-b`) — but not behind a bare `--`, where every
 * word is a path. The letters that take a value here are the creating ones, so
 * a cluster that holds one creates, and no letter before it can hide it.
 *
 * A NAME ALONE CREATES NOTHING, and that includes a residual kept on purpose:
 * where only `origin/main` exists, `git checkout main` makes a local `main` by
 * git's guess. It stays allowed — checking out a branch is how a role reads the
 * tree, and a local branch that tracks a remote one that already exists starts
 * no new line of history.
 */
const createsBranch = ({ short, long }) => (args) => {
  for (const { text } of args) {
    const token = unquote(text);
    if (token === '--') return false; //                     paths from here on
    if (token === '-' || !token.startsWith('-')) continue; // a branch, a commit or `-`, the previous branch
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (long.has(eq < 0 ? token : token.slice(0, eq))) return true;
      continue;
    }
    for (let k = 1; k < token.length; k++) if (short.has(token[k])) return true;
  }
  return false;
};

/**
 * `git reset` MODES that rewrite the working tree to a commit — HEAD's, or the
 * one named, which the branch then moves to. The tree matches that commit after
 * one, so `git status --porcelain` reads clean: work thrown away or a moved
 * HEAD leaves nothing for the session's check to see. The other modes — plain,
 * `--soft`, `--mixed`, `reset <commit> -- <path>` — leave the tree alone and
 * stay allowed: given a commit they move the branch too, but what the commits
 * held then shows in `git status` as changes.
 */
const RESET_REWRITES_TREE = new Set(['--hard', '--merge', '--keep']);

/** Does this `git reset` rewrite the tree? A mode flag does, anywhere before a bare `--`; behind it every word is a path. */
function resetWrites(args) {
  for (const { text } of args) {
    const token = unquote(text);
    if (token === '--') return false;
    if (RESET_REWRITES_TREE.has(token)) return true;
  }
  return false;
}

/**
 * Does this `git symbolic-ref` write? With ONE name it reads what that name
 * points at (`git symbolic-ref --short HEAD`); with two it points the first at
 * the second (`git symbolic-ref HEAD refs/heads/x` moves HEAD, and the tree does
 * not change), and `-d`/`--delete` deletes it. `-m` takes the reason as its
 * value, attached or as the next word — the last letter of a short cluster as
 * elsewhere — and a bare `--` leaves every word after it a name.
 */
function symbolicRefWrites(args) {
  let names = 0;
  let afterSeparator = false;
  let takesValue = false;
  for (const { text } of args) {
    if (takesValue) { takesValue = false; continue; } // the previous option's value
    const token = unquote(text);
    if (afterSeparator || token === '-' || !token.startsWith('-')) { names++; continue; }
    if (token === '--') { afterSeparator = true; continue; }
    if (token === '--delete') return true;
    if (token.startsWith('--')) continue;
    for (let k = 1; k < token.length; k++) {
      if (token[k] === 'd') return true;
      if (token[k] === 'm') { takesValue = k === token.length - 1; break; }
    }
  }
  return names >= 2;
}

/** The subcommands read by their arguments, and the question each one is asked. */
const WRITES_BY_ARGUMENTS = new Map([
  ['branch', branchWrites],
  ['checkout', createsBranch(CHECKOUT_CREATES)],
  ['switch', createsBranch(SWITCH_CREATES)],
  ['tag', tagWrites],
  ['rebase', rebaseWrites],
  ['reset', resetWrites],
  ['symbolic-ref', symbolicRefWrites],
]);

/**
 * A word that OPENS with a subcommand the guard answers for, and which one —
 * built from the two tables above, so a subcommand the guard can find is always
 * one it can answer. Whatever follows the name inside the same word is no
 * argument of it (`(git tag)` ends in `tag)`); a name followed by `-` or a word
 * character is another subcommand altogether.
 */
const SUBCOMMAND = new RegExp(`^(${[...WRITES_HISTORY, ...WRITES_BY_ARGUMENTS.keys()].join('|')})(?![\\w-])`);

/**
 * The subcommands that WRITE when xargs feeds them: what decides each one is in
 * its arguments — a name for `tag` and `branch`, a second name for
 * `symbolic-ref`, a flag anywhere for all five — and under xargs those
 * arguments are lines of input the command never shows: `xargs git tag <
 * names.txt` creates a tag per line. `rebase` needs no entry: its own reading
 * refuses every rebase but an undo or explain word, and git takes that word
 * only as the whole argument list, so anything xargs appends turns it into a
 * usage error. Nor does `reset`: it writes only by one of three mode flags, and
 * what xargs hands it is paths or a commit.
 */
const FED_BY_XARGS_WRITES = new Set(['branch', 'checkout', 'switch', 'symbolic-ref', 'tag']);

/**
 * How deep a quoted word or a command or process substitution is read again
 * inside another. `sh -c "bash -c 'git push'"` is two levels, and joined pieces
 * (`'"'"'`) or nested `$(…)` let the shell go deeper — without end, which the
 * scan must not follow. A level is never longer than the one it came from, so
 * each adds at most one more reading of the command; past the last, a text that
 * still names `git` is refused unread.
 */
const QUOTE_DEPTH = 4;

/** A command whose brackets spent OPAQUE_SCAN_BUDGET, at any level: refused unread, by TOO_DEEP. */
class TooDeep extends Error {}

/**
 * Everything a guarded role may not run, in one question: the comments come off,
 * the command is tokenized once, and each invocation is answered — a history
 * writer always, one fed by xargs when FED_BY_XARGS_WRITES names it, the others
 * by their arguments (WRITES_BY_ARGUMENTS). Then every quoted word and every
 * command or process substitution is asked the same question, because `sh -c
 * 'git commit'`, `$(git commit)` and `>(git commit)` run it. Each step is a single pass and there are at most QUOTE_DEPTH + 1
 * levels, so a 10 KB command costs milliseconds and is never tiled.
 */
const forbidden = (raw, depth = 0) => {
  const { tokens, spans, exhausted } = tokenize(withoutComments(raw));
  if (exhausted) throw new TooDeep();
  return invocations(tokens).some(({ name, args, xargs }) => WRITES_HISTORY.has(name)
    || (xargs && FED_BY_XARGS_WRITES.has(name)) || WRITES_BY_ARGUMENTS.get(name)(args))
    || spans.some((span) => (depth < QUOTE_DEPTH ? forbidden(span, depth + 1) : /\bgit\b/.test(span)));
};
/**
 * THE ROLES THIS GUARD CONTAINS. Every shipped definition runs the same Bash
 * tool and the operating model asks the same thing of each — the coder reports
 * instead of committing, the tester runs the suite and reports what it saw —
 * but until 0.3.4 only the coder's half was ENFORCED and the tester's was prose.
 * A tester that stashed the tree to get a clean run was hiding the very diff the
 * orchestrator was about to review, and nothing stopped it.
 *
 * The reviewer (1.3.0) joins them for the same reason: it has Bash to read the
 * change and run the suite, and a review that committed or stashed would move
 * the tree it was asked to judge. This guard is ALL the enforcement it gets —
 * that it writes nothing but its report is its definition's text and the
 * session's `git status --porcelain` after it.
 *
 * A name is matched WHOLE: `omelette-coder-2` is somebody else's agent, and the
 * main thread carries no `agent_type` at all.
 *
 * The refusal NAMES the agent it caught. Two roles reading one another's line is
 * how an agent decides the block was meant for somebody else.
 *
 * `omelette-coder-medium` (1.3.0) is the coder's own definition at another
 * effort — the same text under a second name — and is contained exactly as the
 * coder is. It is one more whole name, not a prefix: `omelette-coder-medium-2`
 * is somebody else's agent, as `omelette-coder-2` is.
 */
const GUARDED_AGENTS = new Set(['omelette-coder', 'omelette-coder-medium', 'omelette-tester', 'omelette-reviewer']);
const REFUSAL = (agent) => `${agent} never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead`;
const TOO_DEEP = (agent) => `${agent}: command too deep to read (over 1 MiB of bracket scanning) — split it, or write the file with Write`;
const HANDOFF = 'HANDOFF: re-read .omelette/ledger-*.md before continuing.';

/**
 * CURATED FILES: the ones the operating model asks to be appended to, never
 * rewritten — every `.omelette/ledger-*.md`, `.omelette/backlog.md`,
 * `.omelette/decisions.md`, and the file the register's first line `register:
 * <path>` names. A ledger rewritten "with a summary" loses what the next
 * context needed. The harness already refuses an Edit, and a Write on a file
 * the session has Read, once the file moved since that read; a Bash write and a
 * Write to a file never Read were the open paths. These rules close them for
 * EVERY agent, the main thread included, before the git rule's role gate.
 *
 * A path is curated by its NAME: resolved against the event's cwd, `..` folded
 * as text, no symlink followed — the file's own name is what the rule protects,
 * whatever it points to — within the PROJECT the cwd belongs to (projectRoot).
 * The register's path is the one thing read from outside this file:
 * core/ledger.mjs's readRegisterPath, through the one import this guard makes
 * (loadLedgerModule), so the file curated is the file the print reads. Without
 * the module, `.omelette/decisions.md` alone.
 *
 * Containment for an agent asked to behave, as the git rule is, and not a
 * boundary: an expansion the guard does not perform (`$PWD/…`, `~user/…`), a
 * glob that names no ledger, a quoted `sh -c`, or a program that opens the file
 * itself are out of its reach.
 */
const CURATED_NAMES = ['backlog.md', 'decisions.md'];
const LEDGER_GLOB = 'ledger-*.md';
const LEDGER_NAME = /^ledger-.*\.md$/;
const CURATED_BASH = (file) => `${file} is appended to, never rewritten; to replace it on purpose, move it first`;
const CURATED_WRITE = (file) => `${file} is appended to, never rewritten: Edit for an in-place change (the harness checks it has not moved since your read), append otherwise; to replace it on purpose, move it first`;
/** What a guard without core/ledger.mjs curates, said once on stderr. */
const REGISTER_UNREAD = 'its register: redirect is not read, .omelette/decisions.md is curated alone';

const rootCache = new Map(); //    one walk up per cwd, per event
const curatedCache = new Map(); // one register read per project, per event

/**
 * THE PROJECT a cwd belongs to: the nearest directory, cwd included, holding a
 * `.omelette/` directory — a session sitting in `<proj>/sub` still guards
 * `<proj>/.omelette` — else cwd itself, with `omelette: false`. The FLEET HOME
 * (`~/.omelette`, or OMELETTE_HOME) is passed over: it holds the units' state,
 * not a project's, and every project under the home directory without a
 * `.omelette` of its own would otherwise be rooted at `~`.
 */
function projectRoot(cwd) {
  const start = resolve(cwd);
  if (rootCache.has(start)) return rootCache.get(start);
  const own = str(process.env.OMELETTE_HOME).trim();
  const fleet = new Set([join(homedir(), '.omelette'), ...(own ? [resolve(own)] : [])]);
  let found = { root: start, omelette: false };
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, '.omelette');
    try {
      if (!fleet.has(candidate) && statSync(candidate).isDirectory()) { found = { root: dir, omelette: true }; break; }
    } catch { /* not here */ }
    if (dirname(dir) === dir) break;
  }
  rootCache.set(start, found);
  return found;
}

/**
 * Every curated path of the project `cwd` belongs to: absolute paths, the
 * ledgers as the glob `<root>/.omelette/ledger-*.md` (isCurated matches it by
 * name), and the register redirect when the module is loaded and
 * readRegisterPath accepts it — a redirect it refuses curates nothing more.
 */
function curatedTargets(cwd) {
  const { root } = projectRoot(cwd);
  if (curatedCache.has(root)) return curatedCache.get(root);
  const dir = join(root, '.omelette');
  const targets = new Set([...CURATED_NAMES, LEDGER_GLOB].map((name) => join(dir, name)));
  try {
    const register = ledgerModule ? ledgerModule.readRegisterPath(root) : null;
    if (isObject(register) && typeof register.path === 'string') targets.add(resolve(root, register.path));
  } catch { /* a register nobody can read redirects nothing */ }
  curatedCache.set(root, targets);
  return targets;
}

/** Is `path`, resolved against `cwd` and never followed through a link, a curated file? */
function isCurated(cwd, path) {
  const abs = resolve(cwd, path);
  if (curatedTargets(cwd).has(abs)) return true;
  return dirname(abs) === join(projectRoot(cwd).root, '.omelette') && LEDGER_NAME.test(basename(abs));
}

/** …and a bare name whose directory a `cd` made unknown: curated when any curated file carries it. */
function isCuratedName(cwd, name) {
  return LEDGER_NAME.test(name) || [...curatedTargets(cwd)].some((path) => basename(path) === name);
}

/**
 * Is anything at `path` — a file, a link, whatever lstat sees? Only an ABSENT
 * name (ENOENT, ENOTDIR) is not, and an error that says neither is taken as
 * present. A name holding a glob character is never known to be absent:
 * `rm .omelette/ledger-*.md` removes every ledger the glob matches.
 */
function isPresent(path) {
  if (/[*?[]/.test(basename(path))) return true;
  try { lstatSync(path); return true; } catch (e) { return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')); }
}

/**
 * Does a Bash write to `path` REWRITE a curated file? Only one that is there:
 * an absent target has nothing to truncate, for Bash as for Write. A bare name
 * (after a `cd`) is there when a curated file carrying it is.
 */
function rewritesCurated(cwd, path) {
  if (isAbsolute(path)) return isCurated(cwd, path) && isPresent(path);
  if (!isCuratedName(cwd, path)) return false;
  const carrying = [...curatedTargets(cwd)].filter((p) => basename(p) === path);
  if (LEDGER_NAME.test(path)) carrying.push(join(projectRoot(cwd).root, '.omelette', path));
  return carrying.some(isPresent);
}

/**
 * A command's arguments as getopt splits them: the OPTIONS — a short cluster
 * letter by letter, a long one by name — each with the value it takes, for the
 * letters in `valueShort` and the names in `valueLong` (the rest of the
 * cluster, the part after `=`, or the next word); and the OPERANDS, every other
 * word wherever it sits, and every word after a bare `--`.
 */
function parseArgs(args, valueShort = '', valueLong = []) {
  const options = [];
  const operands = [];
  for (let k = 0; k < args.length; k++) {
    const word = args[k];
    if (word === '--') { operands.push(...args.slice(k + 1)); break; }
    if (word === '-' || !word.startsWith('-')) { operands.push(word); continue; }
    if (word.startsWith('--')) {
      const eq = word.indexOf('=');
      const name = eq < 0 ? word : word.slice(0, eq);
      options.push({ name, value: eq >= 0 ? word.slice(eq + 1) : valueLong.includes(name) ? args[++k] : undefined });
      continue;
    }
    for (let j = 1; j < word.length; j++) {
      if (!valueShort.includes(word[j])) { options.push({ name: `-${word[j]}` }); continue; }
      options.push({ name: `-${word[j]}`, value: j < word.length - 1 ? word.slice(j + 1) : args[++k] });
      break;
    }
  }
  return { options, operands };
}

const writesOf = (words, kind = 'write') => words.map((word) => ({ word, kind }));

/** `tee` writes every file it is handed, and only appends to them under `-a`/`--append`. */
function teeWrites(args) {
  const { options, operands } = parseArgs(args);
  return writesOf(operands, options.some(({ name }) => name === '-a' || name === '--append') ? 'append' : 'write');
}

/**
 * `sed` rewrites its files under an in-place flag: `-i` alone or with a suffix
 * attached (`-i.bak`), `--in-place[=suffix]`, or an `i` in a short cluster
 * before a letter that takes a value (`-Ei`, `-ni`). BSD's `-i` takes its
 * suffix as the next word — `sed -i '' …` — read as one when it is empty or a
 * dot and a name without a `/`. The script is the first operand unless
 * `-e`/`-f` supplied one; every other operand is a file it rewrites.
 */
function sedWrites(args) {
  let inPlace = false;
  let script = false;
  const operands = [];
  for (let k = 0; k < args.length; k++) {
    const word = args[k];
    if (word === '--') { operands.push(...args.slice(k + 1)); break; }
    if (word === '-' || !word.startsWith('-')) { operands.push(word); continue; }
    if (word.startsWith('--')) {
      const eq = word.indexOf('=');
      const name = eq < 0 ? word : word.slice(0, eq);
      if (name === '--in-place') inPlace = true;
      else if (name === '--expression' || name === '--file' || name === '--line-length') {
        script = script || name !== '--line-length';
        if (eq < 0) k++;
      }
      continue;
    }
    for (let j = 1; j < word.length; j++) {
      const ch = word[j];
      if (ch === 'i') {
        inPlace = true;
        const suffix = args[k + 1];
        if (j === word.length - 1 && typeof suffix === 'string' && /^(?:$|\.[^/]*$)/.test(suffix)) k++;
        break;
      }
      if (ch === 'e' || ch === 'f' || ch === 'l') {
        script = script || ch !== 'l';
        if (j === word.length - 1) k++;
        break;
      }
    }
  }
  return inPlace ? writesOf(script ? operands : operands.slice(1)) : [];
}

/**
 * `perl` rewrites its files under `-i`: a short cluster holding `i` before a
 * letter whose value runs to the end of the cluster (`-pi`, `-i.bak`; in `-pie`
 * the `e` is the suffix). The program is the value of `-e`/`-E` — the rest of
 * the cluster or the next word — or else the first operand; every other operand
 * is a file. `perl -ne print f` reads.
 */
function perlWrites(args) {
  let inPlace = false;
  let code = false;
  const operands = [];
  for (let k = 0; k < args.length; k++) {
    const word = args[k];
    if (word === '--') { operands.push(...args.slice(k + 1)); break; }
    if (word === '-' || !word.startsWith('-')) { operands.push(word); continue; }
    for (let j = 1; j < word.length && word[1] !== '-'; j++) {
      const ch = word[j];
      if (ch === 'i') { inPlace = true; break; }
      if (ch === 'e' || ch === 'E') { code = true; if (j === word.length - 1) k++; break; }
      if ('CDFIMVdmx'.includes(ch)) break; // the rest of the cluster is this letter's value
    }
  }
  return inPlace ? writesOf(code ? operands : operands.slice(1)) : [];
}

/** `sort -o <file>` writes that file, its input included (`sort -o f f` sorts f in place). */
function sortWrites(args) {
  const { options } = parseArgs(args, 'kotST', ['--output']);
  return writesOf(options.filter(({ name, value }) => (name === '-o' || name === '--output') && value !== undefined).map(({ value }) => value));
}

/**
 * `mv` and `cp` write their DESTINATION: the last operand, or `-t <dir>`'s
 * directory with each source's name. A destination that is a directory — a
 * trailing `/`, `.`, `..`, or one that exists (`intoDir`) — takes each source
 * under its own name: `mv /tmp/backlog.md .omelette` replaces the backlog.
 * `-T` says the destination is a file. Moving a curated file AWAY writes
 * nothing curated, and is how one is replaced on purpose.
 */
function moveWrites(args, intoDir) {
  const { options, operands } = parseArgs(args, 'St', ['--suffix', '--target-directory']);
  const has = (...names) => options.find(({ name }) => names.includes(name));
  const target = has('-t', '--target-directory');
  if (target) return typeof target.value === 'string' ? writesOf(operands.map((src) => join(target.value, basename(src)))) : [];
  if (operands.length < 2) return [];
  const dest = operands[operands.length - 1];
  const into = !has('-T', '--no-target-directory') && intoDir(dest);
  return writesOf([dest, ...(into ? operands.slice(0, -1).map((src) => join(dest, basename(src))) : [])]);
}

/** `rm` and `truncate` write every file they are handed. */
const removeWrites = (args) => writesOf(parseArgs(args).operands);
const truncateWrites = (args) => writesOf(parseArgs(args, 'rs', ['--reference', '--size']).operands);

/** The commands that write the files they are handed, by name. */
const WORD_RULES = new Map([
  ['tee', teeWrites], ['sed', sedWrites], ['perl', perlWrites], ['sort', sortWrites],
  ['mv', moveWrites], ['cp', moveWrites], ['rm', removeWrites], ['truncate', truncateWrites],
]);

/**
 * Words that open a command without being its name: a group or a negation, the
 * shell's own keywords, a variable assignment, and a wrapper that runs the next
 * word — with the options it takes before that word.
 */
const COMMAND_KEYWORDS = new Set(['!', '{', '(', 'if', 'then', 'elif', 'else', 'do', 'while', 'until']);
const COMMAND_WRAPPERS = new Set(['builtin', 'command', 'env', 'exec', 'nice', 'nohup', 'sudo', 'time']);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/**
 * The wrapper options that take the NEXT word as their value — `sudo -u root
 * tee f` runs tee — as short letters and long names. An option this table does
 * not know is stepped over alone, and the next word that is not an option is
 * read as the command.
 */
const WRAPPER_VALUES = {
  sudo: { short: 'CDgpRrTtUu', long: ['--chdir', '--chroot', '--close-from', '--command-timeout', '--group', '--host', '--other-user', '--prompt', '--role', '--type', '--user'] },
  nice: { short: 'n', long: ['--adjustment'] },
  env: { short: 'CPu', long: ['--chdir', '--unset'] },
  exec: { short: 'a', long: [] },
  time: { short: 'fo', long: ['--format', '--output'] },
};

/** Does the wrapper option `word` take the next word as its value? */
function takesValue(wrapper, word) {
  const values = WRAPPER_VALUES[wrapper];
  if (!values || word === '--') return false;
  if (word.startsWith('--')) return !word.includes('=') && values.long.includes(word);
  for (let j = 1; j < word.length; j++) if (values.short.includes(word[j])) return j === word.length - 1;
  return false;
}

/**
 * A word without the closing parentheses a subshell's last word carries: `(cd
 * x && cat > y)`. Counted from the end, once: a regex over a long run of `)`
 * is quadratic, and this runs on every word of every Bash call.
 */
function closed(word) {
  if (word.includes('(')) return word;
  let end = word.length;
  while (end > 0 && word.charCodeAt(end - 1) === 0x29) end--;
  return end === word.length ? word : word.slice(0, end);
}

/**
 * The simple commands among the words: for each run between separators, the
 * command's name (its basename, past COMMAND_KEYWORDS, assignments, and a
 * wrapper with its options and their values), its arguments with their quotes
 * off, and the index of its name.
 */
function simpleCommands(tokens) {
  const commands = [];
  let run = [];
  const flush = () => {
    let wrapper = null;
    let value = false; // the next word is a wrapper option's value
    for (let k = 0; k < run.length; k++) {
      const word = run[k].word.replace(/^[({!]+/, '');
      if (value) { value = false; continue; }
      if (!word || COMMAND_KEYWORDS.has(word) || ASSIGNMENT.test(word)) continue;
      if (wrapper && word.startsWith('-')) { value = takesValue(wrapper, word); continue; }
      if (COMMAND_WRAPPERS.has(word)) { wrapper = word; continue; }
      commands.push({ name: basename(word), args: run.slice(k + 1).map(({ word: arg }) => closed(arg)), at: run[k].at });
      break;
    }
    run = [];
  };
  tokens.forEach((token, at) => {
    if (token.separator) flush();
    else run.push({ word: unquote(token.text), at });
  });
  flush();
  return commands;
}

/**
 * A word as a path the guard knows, or null. `~` and `~/…` are the home
 * directory, quoted or not (a quoted `~` is the shell's literal, read here as
 * the home all the same: the guard fails closed). An expansion it does not
 * perform — `$PWD/x`, a substitution, `~user/x` — is not a known path.
 */
function knownPath(word) {
  if (!word || /[$`]/.test(word) || /^[<>]?\(/.test(word)) return null;
  if (word === '~' || word.startsWith('~/')) return join(homedir(), word.slice(1));
  return word.startsWith('~') ? null : word;
}

/** Would `mv`/`cp` put the sources INTO `word`? Lexically, or by a stat (followed, as they follow it) where the directory is known. */
function intoDirectory(word, cwd, afterCd) {
  const path = knownPath(word);
  if (path === null) return false;
  if (path.endsWith('/') || path === '.' || path === '..') return true;
  if (afterCd && !isAbsolute(path)) return false;
  try { return statSync(resolve(cwd, path)).isDirectory(); } catch { return false; }
}

/**
 * EVERY PATH A BASH COMMAND WRITES, as far as its words say: each redirection
 * that writes a file (`>`, `>|`, `<>`, `&>` rewrite it; `>>`, `&>>` append),
 * and the commands in WORD_RULES. Each entry `{ path, name, kind }` — `kind`
 * `write` or `append` — in the order the words come, `path` always resolved
 * against `cwd`. After a `cd` or `pushd` at command position, in a project
 * holding `.omelette/`, a relative path's directory is unknown: `name` carries
 * its bare name, which the curated rule compares (bashTruncates), and is
 * undefined otherwise. A word the guard cannot know as a path (knownPath) is
 * left out.
 *
 * Top-level words only: what a quoted `sh -c` or a substitution runs is not
 * read here. A command whose brackets spent the scan budget is not read at all:
 * TooDeep is thrown, as `forbidden` throws it, and the caller refuses it.
 */
function bashWrites(command, cwd) {
  const { tokens, targets, exhausted } = tokenize(withoutComments(String(command)));
  if (exhausted) throw new TooDeep();
  const commands = simpleCommands(tokens);
  const cd = commands.find(({ name }) => name === 'cd' || name === 'pushd');
  const cdAt = cd && projectRoot(cwd).omelette ? cd.at : -1;
  const afterCd = (at) => cdAt >= 0 && cdAt < at;
  const found = [];
  const add = (word, kind, at) => {
    const path = knownPath(closed(word));
    if (path === null) return;
    found.push({ path: resolve(cwd, path), name: afterCd(at) && !isAbsolute(path) ? basename(path) : undefined, kind, at });
  };
  for (const { path, op, at } of targets) add(path, APPEND_REDIRECTS.has(op) ? 'append' : 'write', at);
  for (const { name, args, at } of commands) {
    const rule = WORD_RULES.get(name);
    if (rule) for (const { word, kind } of rule(args, (dest) => intoDirectory(dest, cwd, afterCd(at)))) add(word, kind, at);
  }
  return found.sort((a, b) => a.at - b.at).map(({ path, name, kind }) => ({ path, name, kind }));
}

/**
 * The first curated file the command REWRITES (rewritesCurated), or null —
 * compared, and named, by its bare `name` after a `cd`. `found` is bashWrites'
 * answer, when the caller has it.
 */
function bashTruncates(command, cwd, found = bashWrites(command, cwd)) {
  const hit = found.find(({ path, name, kind }) => kind === 'write' && rewritesCurated(cwd, name ?? path));
  return hit ? hit.name ?? hit.path : null;
}

/**
 * Is this Write an APPEND to `filePath`? Yes when nothing is there yet, or when
 * `content` starts with the file's current bytes, byte for byte — so the file
 * re-encoded (CRLF for LF, its last newline dropped) is not one. Anything at the
 * name that is not a regular file — a symlink above all, whatever it points to —
 * is never appended to, and neither is a file this guard cannot read. The file
 * is read only when it is no longer than `content`, through one O_NOFOLLOW |
 * O_NONBLOCK descriptor that must fstat as a regular file.
 */
function writeIsAppend(cwd, filePath, content) {
  const path = resolve(cwd, filePath);
  let st;
  try { st = lstatSync(path); } catch (e) { return !!e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'); }
  const next = Buffer.from(typeof content === 'string' ? content : '', 'utf8');
  if (!st.isFile() || st.size > next.length) return false;
  let fd = null;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const now = fstatSync(fd);
    if (!now.isFile() || now.size > next.length) return false;
    const current = readFileSync(fd);
    return current.length <= next.length && next.subarray(0, current.length).equals(current);
  } catch { return false; } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/** A path as a refusal names it: relative to the project root when it lies inside it, as given otherwise. */
function shown(cwd, path) {
  if (!isAbsolute(path)) return clean(path);
  const rel = relative(projectRoot(cwd).root, path);
  return clean(rel && !isAbsolute(rel) && rel.split(sep)[0] !== '..' ? rel.split(sep).join('/') : path);
}

/**
 * The curated rules' answer to one PreToolUse event: the refusal, or null. A
 * Bash command is read by bashWrites — one too deep to read is refused by
 * TOO_DEEP for every agent, the main thread included, since nothing past the
 * budget was read — and a Write by its `file_path` and writeIsAppend. The
 * module is loaded only for an event that may need the register's path: a
 * Bash command that rewrites something, or any Write.
 */
async function curatedRefusal(event, input, cwd) {
  if (event.tool_name === 'Bash') {
    const command = str(input.command);
    let found;
    try { found = bashWrites(command, cwd); } catch (e) {
      if (e instanceof TooDeep) return TOO_DEEP(str(event.agent_type, 'main thread'));
      throw e;
    }
    if (!found.some(({ kind }) => kind === 'write')) return null;
    await loadLedgerModule(REGISTER_UNREAD);
    const hit = bashTruncates(command, cwd, found);
    return hit ? CURATED_BASH(shown(cwd, hit)) : null;
  }
  if (event.tool_name === 'Write' && str(input.file_path)) {
    await loadLedgerModule(REGISTER_UNREAD);
    if (!isCurated(cwd, input.file_path) || writeIsAppend(cwd, input.file_path, input.content)) return null;
    return CURATED_WRITE(shown(cwd, resolve(cwd, input.file_path)));
  }
  return null;
}

/**
 * Stdin is somebody else's pipe: it can be far bigger than any real event and
 * it can simply never close. Both are answered the same way — stop, and exit 0
 * — because a guard that buffers without bound or waits without end is a
 * session that hangs on every tool call.
 *
 * The cap is 8 MiB rather than a tidier 1: stdin is read whole before the
 * event is named, and a settings file still wiring the retired `PostToolUse`
 * (1.5.0 answers it with exit 0) sends events carrying a tool's own
 * `tool_response` — a few megabytes of command output on one call is ordinary.
 * A `PreToolUse` event with a long command must never be cut short of its
 * refusal, so the cap fits the largest event any wiring can send.
 */
const MAX_STDIN = 8 * 1024 * 1024; // 8 MiB — well above a real hook event, and above a big one
const STDIN_DEADLINE_MS = 5000;

const str = (v, fallback = '') => (typeof v === 'string' && v ? v : fallback);

/** A plain object — what every record this guard reads has to be before it is read. */
const isObject = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

/**
 * WHAT `rules --hooks` RENDERED HERE. This script imports nothing from the
 * package for what it refuses or prints — it is copied into a project as one
 * file — so the operator's
 * `handoff` block arrives as a JSON literal substituted at render time, exactly
 * the way the version marker is. `doctor` reads THIS LINE back out of the installed
 * script, which is how a switch changed in the config and never re-rendered is
 * visible instead of merely wrong.
 */
const HANDOFF_CONFIG = {{handoff}};

/**
 * …the same switch, defended against a literal somebody edited by hand: only an
 * explicit `false` turns the stamp and the print off. A key a guard rendered
 * before 1.5.0 carried (`threshold`, `contextWindow`, `compactSummary`) is
 * read by nothing.
 */
const AUTO_HANDOFF = {
  enabled: !isObject(HANDOFF_CONFIG) || HANDOFF_CONFIG.enabled !== false,
};

/**
 * THE OTHER RENDERED VALUE: the package root `rules --hooks` ran from, as a
 * JSON string literal, and the one module this guard loads from it — the
 * ledger sweep, `core/ledger.mjs`, which archives a ledger whose branch is gone
 * before it is stamped or printed. It is loaded by one dynamic import inside
 * try/catch (loadLedgerModule), by the two ledger events and by a PreToolUse
 * call the curated rule has to answer (the register's path): a package moved or
 * removed since the render costs the sweep, the register redirect and one
 * stderr line, never a stamp or a print, and never a refusal of its own.
 * `doctor` reads this line back and names a root that no longer holds the
 * module.
 *
 * `String()`, because the literal is a line somebody can edit by hand, and a
 * `join` that throws up here would take the git guard down with it.
 */
const PACKAGE_ROOT = {{package}};
const LEDGER_MODULE = join(String(PACKAGE_ROOT), 'core', 'ledger.mjs');
const IMPORT_CLOCK_MS = 2000;

/** A file name in a heading of the print: C0 and C1 controls, DEL and the line separators shown as `\xNN` / `\uNNNN`, never raw. */
const clean = (name) => String(name).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, (c) => c.charCodeAt(0) < 0x100 ? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}` : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

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

const FENCE_REFUSAL = 'omelette-reviewer writes nothing but .omelette/reports/<name>-review.md';
const FENCED_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/**
 * Whether the reviewer may write `filePath`: a `<name>-review.md` directly in
 * `<cwd>/.omelette/reports/`. Anchored on the realpath'd project: its
 * `.omelette` must be a real directory, never a link out. Compared through
 * realpathSync.native, so a case alias resolves to the on-disk case and a
 * symlinked file or directory fails the equality. The file is realpath'd when
 * anything sits at it, its directory likewise (a dangling link throws, and is
 * refused); a reports/ not yet created is compared as its realpath'd parent plus
 * the literal name — the first report, whose directory the Write tool creates
 * itself, from a project reached through a symlinked path too.
 */
function reviewerMayWrite(cwd, filePath) {
  if (!filePath) return false;
  const name = basename(filePath);
  if (!/^[^/]+-review\.md$/.test(name)) return false;
  try {
    const root = realpathSync.native(cwd);
    const own = lstatSync(join(root, '.omelette'));
    if (!own.isDirectory() || own.isSymbolicLink()) return false;
    const expected = join(root, '.omelette', 'reports');
    const resolved = resolve(cwd, filePath);
    if (existsSync(resolved) || lstatExists(resolved)) return realpathSync.native(resolved) === join(expected, name);
    const dir = dirname(resolved);
    if (lstatExists(dir)) return realpathSync.native(dir) === expected;
    return join(realpathSync.native(dirname(dir)), basename(dir)) === expected;
  } catch { return false; }
}

/** True when something — a dangling symlink included — sits at `path`. */
function lstatExists(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

/**
 * Exit 2 = "do not run this", with the reason on stderr for the agent to read.
 * The curated rules first, for every agent and the main thread; then the
 * reviewer's write fence; then the git rule, for the guarded roles' Bash calls.
 */
async function preToolUse(event) {
  const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
  let reason = await curatedRefusal(event, input, resolve(str(event.cwd, process.cwd())));
  const agent = str(event.agent_type);
  if (!reason && agent === 'omelette-reviewer' && FENCED_TOOLS.has(event.tool_name)) {
    const path = str(event.tool_name === 'NotebookEdit' ? input.notebook_path : input.file_path);
    if (reviewerMayWrite(resolve(str(event.cwd, process.cwd())), path)) return;
    reason = FENCE_REFUSAL;
  }
  if (!reason) {
    if (!GUARDED_AGENTS.has(agent) || event.tool_name !== 'Bash') return;
    reason = REFUSAL(agent);
    try {
      if (!forbidden(str(input.command))) return;
    } catch (e) {
      if (!(e instanceof TooDeep)) throw e;
      reason = TOO_DEEP(agent);
    }
  }
  // exitCode, not exit(): the process leaves on its own once stderr is flushed.
  // Set first, so a stderr that cannot be written to still refuses the call.
  process.exitCode = 2;
  say(process.stderr, `${reason}\n`);
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

/** This project's ledgers, sorted — the same set PreCompact stamps and SessionStart prints. */
function ledgerNames(dir) {
  try { return readdirSync(dir).filter((f) => /^ledger-.*\.md$/.test(f)).sort(); } catch { return []; }
}

/** The first line of an error message, for a stderr line that stays one line. */
const firstLine = (s) => String(s || '').split(HANDOFF_LINE_BREAK, 1)[0];

let ledgerModule; // undefined until the first load; the module, or null, after it

/**
 * The sweep's module, imported from PACKAGE_ROOT — or null, said ONCE on
 * stderr: a guard whose package has moved still stamps, prints and refuses,
 * and the line says what was `skipped` and what brings it back.
 */
async function loadLedgerModule(skipped = 'ledger sweep skipped') {
  if (ledgerModule !== undefined) return ledgerModule;
  // Under a wall clock: a module whose own top-level await never settles would
  // otherwise leave this guard's await unsettled too, and Node exits 13 with the
  // print lost. The timer is cleared the moment the import settles; it holds
  // the process open only in that broken case, and for 2 s at most.
  let timer;
  const clock = new Promise((resolve) => { timer = setTimeout(() => resolve(null), IMPORT_CLOCK_MS); });
  try {
    ledgerModule = await Promise.race([import(pathToFileURL(LEDGER_MODULE).href), clock]);
    if (ledgerModule === null) say(process.stderr, `omelette-guard: ${LEDGER_MODULE} did not load within ${IMPORT_CLOCK_MS / 1000} s — ${skipped}\n`);
  } catch {
    ledgerModule = null;
    say(process.stderr, `omelette-guard: cannot load ${LEDGER_MODULE} — ${skipped}; run omelette-fleet rules --hooks\n`);
  } finally {
    clearTimeout(timer);
  }
  return ledgerModule;
}

/**
 * One sweep of the project at `cwd`: its result, with the line that says why
 * nothing was swept on stderr when there is one — or null, and one stderr
 * line, when the sweep threw. Either way the caller goes on.
 */
function runSweep(mod, cwd) {
  try {
    const r = mod.sweepLedgers(cwd);
    if (!isObject(r)) return null;
    if (r.error) say(process.stderr, `omelette-guard: ${r.error}\n`);
    return r;
  } catch (e) {
    say(process.stderr, `omelette-guard: ledger sweep failed — ${firstLine(e && e.message)}\n`);
    return null;
  }
}

/** The ledgers a sweep found closed and left in the root (a collision, a file it could not move). */
function closedNames(swept) {
  const ledgers = swept && Array.isArray(swept.ledgers) ? swept.ledgers : [];
  return new Set(ledgers.filter((l) => isObject(l) && l.state === 'closed').map((l) => l.name));
}

/**
 * ONE BLOCK, APPENDED TO EVERY LEDGER of a project that is ours to write —
 * PreCompact's re-read stamp, and the one place that says what may be written
 * to a ledger at all.
 *
 * A ledger we cannot write is not a reason to fail somebody's compaction — and
 * one that is not a REGULAR file is not a ledger at all: lstat (never stat) so
 * a symlink is seen as a symlink and skipped instead of followed out of
 * .omelette, and a FIFO named like a ledger is skipped instead of blocking the
 * append until somebody opens the other end.
 *
 * Then O_NOFOLLOW on the open itself, because the lstat and the append are two
 * syscalls: a link planted between them is what the flag answers.
 *
 * A name in `skip` is passed over: a ledger the sweep found closed is not one
 * anybody has to re-read.
 */
function appendToLedgers(found, text, skip = new Set()) {
  for (const name of (found.exists ? ledgerNames(found.dir) : [])) {
    if (skip.has(name)) continue;
    const path = join(found.dir, name);
    let fd = null;
    try {
      if (!lstatSync(path).isFile()) continue;
      fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW | NONBLOCK);
      if (!fstatSync(fd).isFile()) continue;
      writeSync(fd, text);
    } catch { /* ignore */ } finally {
      if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
    }
  }
}

/**
 * WHICH COMPACTION THIS WAS, in the two words Claude Code documents for it.
 * The value lands inside a heading line of a Markdown file, so anything else —
 * a word this guard has never heard of, and above all a string carrying a
 * newline and a `## Handoff` behind it — is `unknown` rather than written out:
 * a field of somebody else's event must not be able to forge a heading in the
 * ledger the SessionStart print reads.
 */
const TRIGGERS = new Set(['manual', 'auto']);
const triggerOf = (event) => (TRIGGERS.has(event.trigger) ? event.trigger : 'unknown');

/**
 * WHERE THE REPOSITORY STOOD (1.8.0): branch, short HEAD and the number of
 * dirty files, so the stamp records facts and not only a time. Git runs in its
 * own environment — PATH reduced to its absolute entries (git runs with cwd =
 * the project, where a relative `bin` would be the project's own files), no
 * optional locks, no prompt — under a 2 s wall clock each. Every value is held
 * to the trigger's rule before it reaches the heading; anything else, and any
 * failure, is `unknown`.
 */
const FACT = /^[\w./-]{1,64}$/;
const GIT_TIMEOUT_MS = 2000;

function gitEnv() {
  const env = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['HOME', 'LANG', 'LC_ALL']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const path = String(process.env.PATH || '').split(PATH_DELIMITER).filter((p) => p && isAbsolute(p));
  if (path.length) env.PATH = path.join(PATH_DELIMITER);
  return env;
}

function repoFacts(cwd) {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd, env: gitEnv(), timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  const fact = (out) => (out !== null && FACT.test(out.trim()) ? out.trim() : 'unknown');
  const status = git(['status', '--porcelain']);
  return {
    branch: fact(git(['rev-parse', '--abbrev-ref', 'HEAD'])),
    head: fact(git(['rev-parse', '--short', 'HEAD'])),
    dirty: status === null ? 'unknown' : String(status.split('\n').filter((l) => l.length > 0).length),
  };
}

/**
 * Sweep, then mark every ledger left open or untracked, then say so on stdout —
 * unless `handoff.enabled` is false. The sweep comes FIRST: a ledger it
 * archives is not stamped, and one it found closed but could not move is
 * skipped. Without the module every ledger in the root is stamped, as before
 * 1.7.3.
 */
async function preCompact(event) {
  if (!AUTO_HANDOFF.enabled) return;
  const found = ledgerDir(event);
  if (!found) return; // a `.omelette` that is not ours to write: no marker, and nothing to announce
  // No ledger — no `.omelette`, or one without a `ledger-*.md` — means nothing
  // to sweep or stamp, so nothing is announced: the ledger is the opt-in.
  if (!found.exists || !ledgerNames(found.dir).length) return;
  const mod = await loadLedgerModule();
  const swept = mod ? runSweep(mod, str(event.cwd, process.cwd())) : null;
  const skip = closedNames(swept);
  const { branch, head, dirty } = repoFacts(str(event.cwd, process.cwd()));
  appendToLedgers(found, `\n## Compaction ${new Date().toISOString()} (trigger: ${triggerOf(event)}) — branch ${branch} · HEAD ${head} · ${dirty} dirty files — re-read this ledger before continuing\n`, skip);
  if (!ledgerNames(found.dir).some((n) => !skip.has(n))) return;
  say(process.stdout, `${HANDOFF}\n`);
}

/** A level-2 heading, and the one that opens a handoff block. `### Handoff` is neither. */
const HEADING = /^##\s/;

/**
 * THE HANDOFF HEADING, as the SessionStart print reads it.
 *
 * `[ \t]` and not `\s`, because a `\s` spans the newline and `##\nHandoff` is
 * two lines, neither of them a handoff heading. `\b` and not the bare word,
 * because `## Handoffs, and why we write them` is a heading ABOUT handoffs.
 * It is tested a LINE at a time, and a line inside a fenced block is skipped
 * (lastHandoffBlock): a heading quoted in a fence is an example.
 */
const HANDOFF_HEADING_SOURCE = '^##[ \\t]+handoff\\b';
const HANDOFF_HEADING = new RegExp(HANDOFF_HEADING_SOURCE, 'i');

/** A fenced block's delimiter, indented up to 3 spaces, as Markdown spells one. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Where a ledger line ends, for lastHandoffBlock: `\r\n`, `\n`, `\r`, U+2028
 * and U+2029 — the breaks a JavaScript `m` regex ends a line at.
 */
const HANDOFF_LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;
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
  const lines = String(text || '').split(HANDOFF_LINE_BREAK);
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

/** The two sources that lost a context, and the only two the print runs on. */
const PRINT_SOURCES = new Set(['compact', 'clear']);
/** The register prints whole up to this, and its last this-many bytes past it. */
const REGISTER_PRINT_MAX = 6 * 1024;
/** The backlog is read this far from its head; its first table prints up to BACKLOG_PRINT_MAX. */
const BACKLOG_READ_MAX = 64 * 1024;
const BACKLOG_PRINT_MAX = 2 * 1024;
const REGISTER_TAIL_NOTE = '[… register larger than 6 KB — its last 6 KB]';
/** Why the register is not printed when the module that knows where it is did not load. */
const MODULE_MISSING = 'the guard could not load core/ledger.mjs — run omelette-fleet rules --hooks';

/**
 * The last `max` bytes of a regular file, opening on a whole line — or null
 * when the path is not a regular file or cannot be read. `tailed` says the
 * file was longer than `max`, so what came back is its end and not all of it.
 *
 * lstat (never stat) so a symlink is seen and refused rather than followed,
 * O_NOFOLLOW on the open against the race between those two syscalls, and
 * O_NONBLOCK so a FIFO planted under the name cannot hold the open.
 */
function readTail(path, max) {
  try {
    if (!lstatSync(path).isFile()) return null;
    const fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    try {
      // fstat, on the descriptor actually opened: it is the size the read is
      // about to use, and it settles what lstat only said a moment ago.
      const st = fstatSync(fd);
      if (!st.isFile()) return null;
      const offset = Math.max(0, st.size - max);
      // THE READ STARTS ONE BYTE EARLY: `^` is a line start only where a
      // line ended, and a tail that opens in the middle of a line would make
      // `## Handoff` out of the rest of one — an escaped `\## Handoff`, as the
      // compaction summaries of 0.3.7–1.4.0 left them in a ledger, is exactly
      // that shape. A newline in that byte means the tail opens a line of its
      // own; anything else means the first line is the tail of an older one
      // and goes, the newline itself kept so the next line still starts one.
      const from = offset > 0 ? offset - 1 : 0;
      const length = st.size - from;
      if (!length) return { text: '', tailed: false };
      const buf = Buffer.alloc(length);
      let text = buf.subarray(0, readSync(fd, buf, 0, length, from)).toString('utf8');
      if (offset > 0 && text[0] !== '\n') {
        const nl = text.indexOf('\n');
        text = nl < 0 ? '' : text.slice(nl);
      }
      return { text, tailed: offset > 0 };
    } finally { closeSync(fd); }
  } catch { return null; } // a file we may not read is not a reason to fail a session start
}

/** The first `max` bytes of a regular file as UTF-8, under readTail's checks — or null. */
function readHead(path, max) {
  try {
    if (!lstatSync(path).isFile()) return null;
    const fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return null;
      const length = Math.min(max, st.size);
      if (!length) return '';
      const buf = Buffer.alloc(length);
      return buf.subarray(0, readSync(fd, buf, 0, length, 0)).toString('utf8');
    } finally { closeSync(fd); }
  } catch { return null; }
}

/**
 * THE FIRST TABLE of a Markdown text: from the first line that opens with `|`
 * to the line before the next blank one, or the end. Kept by whole lines while
 * they fit BACKLOG_PRINT_MAX, with a `[… truncated]` line where the next one
 * does not. '' when there is no table.
 */
function firstTable(text) {
  const lines = String(text || '').split(HANDOFF_LINE_BREAK);
  const start = lines.findIndex((l) => /^\|/.test(l));
  if (start < 0) return '';
  const kept = [];
  let bytes = 0;
  for (let i = start; i < lines.length && !/^\s*$/.test(lines[i]); i++) {
    const size = Buffer.byteLength(lines[i], 'utf8') + 1;
    if (bytes + size > BACKLOG_PRINT_MAX) { kept.push(TRUNCATED); break; }
    kept.push(lines[i]);
    bytes += size;
  }
  return kept.join('\n');
}

/**
 * WHERE THE WORK STANDS: one section per ledger in the root that has a handoff
 * block. With a sweep result, a ledger it found closed (held in place by a
 * collision) is left out, and the order is the open, standing and unknown ones
 * — and any the sweep did not list — by name, then the untracked ones by name:
 * the ledger of the plan in flight before the notes nobody tied to a branch.
 * Without one, every ledger by name, as before 1.7.3.
 */
function ledgerSections(dir, names, swept) {
  const states = new Map();
  if (swept && Array.isArray(swept.ledgers)) {
    for (const l of swept.ledgers) if (isObject(l)) states.set(l.name, l.state);
  }
  const order = swept
    ? [
      ...names.filter((n) => states.get(n) !== 'closed' && states.get(n) !== 'untracked'),
      ...names.filter((n) => states.get(n) === 'untracked'),
    ]
    : names;
  const sections = [];
  for (const name of order) {
    const read = readTail(join(dir, name), LEDGER_READ_MAX);
    if (!read) continue;
    const block = lastHandoffBlock(read.text);
    if (!block) continue;
    sections.push(`--- ${clean(name)} · last handoff ---\n${read.tailed ? `${TAIL_NOTE}\n` : ''}${block}\n`);
  }
  return sections;
}

/**
 * WHAT WAS DECIDED: the decisions register, under a heading naming the file it
 * is (`register:` redirect included). Whole up to REGISTER_PRINT_MAX, past it
 * the tail under REGISTER_TAIL_NOTE — the newest rulings are at the end. A
 * register the module refused, or a module that never loaded, is one heading
 * saying why; an absent or empty register is no section.
 */
function registerSection(register) {
  if (register === null) return `--- decisions register not printed: ${MODULE_MISSING} ---\n`;
  if (register.error) return `--- decisions register not printed: ${register.error} ---\n`;
  const read = readTail(register.path, REGISTER_PRINT_MAX);
  if (!read || !read.text.trim()) return '';
  const lines = read.text.split(HANDOFF_LINE_BREAK);
  // A tail opens on the newline the one-byte-early read kept: not a line of the register.
  if (read.tailed && lines[0] === '') lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return `--- ${clean(register.rel)} · decisions register ---\n${read.tailed ? `${REGISTER_TAIL_NOTE}\n` : ''}${lines.join('\n')}\n`;
}

/** WHAT COMES NEXT: the first table of `.omelette/backlog.md`, or no section. */
function backlogSection(dir) {
  const table = firstTable(readHead(join(dir, 'backlog.md'), BACKLOG_READ_MAX) || '');
  return table ? `--- .omelette/backlog.md · first table ---\n${table}\n` : '';
}

/**
 * The handoff, back into a context that just lost it: on `compact` and `clear`
 * only. A startup, a resume and a fork have a context nobody lost, and printing
 * into each of them is noise on every session. `.omelette/` existing is the
 * opt-in: without it nothing is swept, read or printed.
 *
 * The sweep runs FIRST, on every source — a branch merged and deleted since the
 * last session has its ledger archived at the next start, whatever kind of
 * start it is — and the print takes its ledger order and its register path
 * from the sweep's result. With no ledger left to sweep, the register path
 * comes from the module directly, so a `/clear` after the sweep has emptied the
 * root still hands over the register and the backlog.
 *
 * THREE SECTIONS, in the order of the three questions a fresh context asks:
 *   1. where the work stands — the last handoff block of each ledger left in
 *      the root, open ones before untracked ones (ledgerSections);
 *   2. what was decided — the decisions register, 6 KB from its tail
 *      (registerSection);
 *   3. what comes next — the first table of `.omelette/backlog.md`, 2 KB by
 *      whole lines (backlogSection).
 * Each opens on a one-line heading naming the file it came from.
 *
 * Same ledgers as PreCompact and the same rule about them — `<cwd>/.omelette/
 * ledger-*.md`, sorted, a directory that is not a symlink (ledgerDir), and
 * every file read through readTail: a symlink seen and skipped rather than
 * followed out of the directory, a FIFO skipped rather than blocking the read.
 *
 * Each ledger is read at most 1 MiB FROM ITS TAIL — a ledger grows by appending,
 * so the last handoff is at the END, and a head-first read of a long-running
 * plan's ledger hands the next context a block that was superseded weeks ago.
 * A tail read says so, above the block, because it is not the whole file.
 *
 * Each block is bounded by lastHandoffBlock, and the print as a whole stops at
 * 12 KB. The register and the backlog are RESERVED first — each at its own cap,
 * heading included — and the handoffs get only what is left, so a long list of
 * ledgers never crowds out what was decided and what comes next: the first
 * handoff that does not fit is dropped WHOLE with every handoff after it, and
 * one truncation line says so where they stop, because half a handoff read as
 * a whole one is worse than a line saying it was left out.
 *
 * Nothing to print is printed as nothing: no header, no blank line, exit 0 —
 * and nothing at all is read while `handoff.enabled` is false.
 */
async function sessionStart(event) {
  if (!AUTO_HANDOFF.enabled) return;
  const found = ledgerDir(event);
  if (!found || !found.exists) return;
  const cwd = str(event.cwd, process.cwd());
  const printing = PRINT_SOURCES.has(str(event.source));
  const names = ledgerNames(found.dir);
  if (!names.length && !printing) return;
  const mod = await loadLedgerModule();
  const swept = mod && names.length ? runSweep(mod, cwd) : null;
  if (!printing) return;

  // null means one thing only: the module did not load.
  let register = null;
  if (mod) {
    try { register = (swept && swept.register) || mod.readRegisterPath(cwd); } catch { register = null; }
    if (!isObject(register)) register = { error: 'register: unreadable' };
  }
  const bytes = (s) => Buffer.byteLength(s, 'utf8');
  const marker = `${TRUNCATED}\n`;
  const parts = [];
  let total = 0;
  let marked = false;
  // Sections in order while they fit `limit`; the first that does not goes
  // with the rest of `sections`, and ONE marker line says so — room made for
  // it, if need be, by dropping the last section this call admitted.
  const fill = (sections, limit) => {
    const from = parts.length;
    for (const section of sections) {
      const part = `${parts.length ? '\n' : ''}${section}`;
      if (total + bytes(part) <= limit) { parts.push(part); total += bytes(part); continue; }
      if (!marked) {
        while (parts.length > from && total + bytes(marker) > limit) total -= bytes(parts.pop());
        parts.push(marker);
        total += bytes(marker);
        marked = true;
      }
      return;
    }
  };
  // The register and the backlog first, each at its own cap with the blank
  // line before it: the handoffs get what they leave, so both always fit.
  const reserved = [registerSection(register), backlogSection(found.dir)].filter(Boolean);
  fill(ledgerSections(found.dir, ledgerNames(found.dir), swept), HANDOFF_TOTAL_MAX - reserved.reduce((n, s) => n + bytes(s) + 1, 0));
  fill(reserved, HANDOFF_TOTAL_MAX);
  if (parts.length) say(process.stdout, parts.join(''));
}

/**
 * THE TRANSCRIPT'S BOUNDS. It is read from its start up to TRANSCRIPT_MAX
 * bytes whatever its size, in TRANSCRIPT_CHUNK reads; a line longer than
 * TRANSCRIPT_LINE_MAX is dropped unread; the clock is checked after every
 * chunk, from the moment subagentStop starts.
 */
const TRANSCRIPT_MAX = 16 * 1024 * 1024;
const TRANSCRIPT_LINE_MAX = 1024 * 1024;
const TRANSCRIPT_CHUNK = 64 * 1024;
const TRANSCRIPT_CLOCK_MS = 2000;
/** An agent id as the record's name and heading carry it: what the harness writes (`a03580c80d5192a6d`), nothing that walks a path. */
const AGENT_ID = /^[\w-]{1,64}$/;
/** The tools whose path input is a file they write, and the input that names it. */
const PATH_TOOLS = { Write: 'file_path', Edit: 'file_path', NotebookEdit: 'notebook_path' };
/** A Bash write under `/dev/` (`2>/dev/null`, `>/dev/stderr`) touches no file: counted, never listed. The curated rules do not use this. */
const writesNoFile = (path) => path.startsWith('/dev/');

/**
 * Where a transcript may lie: under `~/.claude/projects` or
 * `$CLAUDE_CONFIG_DIR/projects`. Compared after `resolve` — `..` folded as
 * text, no symlink followed — and the open behind it is O_NOFOLLOW.
 */
function transcriptAllowed(path) {
  const roots = [resolve(homedir(), '.claude', 'projects')];
  const config = str(process.env.CLAUDE_CONFIG_DIR).trim();
  if (config) roots.push(resolve(config, 'projects'));
  return roots.some((root) => {
    const rel = relative(root, path);
    return !!rel && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
  });
}

/**
 * Every line of the transcript open on `fd`, handed to `onLine` as a string,
 * within the bounds above. Returns what was not read: `overlong` lines, and
 * whether the read stopped at the cap with bytes behind it (`pastCap`) or at
 * the clock (`timedOut`). A line cut by either is not read.
 */
function readTranscriptLines(fd, started, onLine) {
  const left = { overlong: 0, pastCap: false, timedOut: false };
  let pending = [];
  let bytes = 0;
  let tooLong = false;
  const endLine = () => {
    if (tooLong) left.overlong++;
    else if (bytes) onLine(Buffer.concat(pending, bytes).toString('utf8'));
    pending = [];
    bytes = 0;
    tooLong = false;
  };
  let offset = 0;
  while (offset < TRANSCRIPT_MAX) {
    // Before every read but the first: a chunk read is always handed on, and
    // past the clock the next read is not made — even one that would have found
    // the end, so a file read whole can still say it stopped at 2 s.
    if (offset && Date.now() - started > TRANSCRIPT_CLOCK_MS) { left.timedOut = true; return left; }
    const chunk = Buffer.allocUnsafe(Math.min(TRANSCRIPT_CHUNK, TRANSCRIPT_MAX - offset));
    const n = readSync(fd, chunk, 0, chunk.length, offset);
    if (!n) { endLine(); return left; }
    offset += n;
    const data = chunk.subarray(0, n);
    for (let from = 0; ;) {
      const nl = data.indexOf(0x0a, from);
      const piece = data.subarray(from, nl < 0 ? n : nl);
      if (!tooLong && bytes + piece.length > TRANSCRIPT_LINE_MAX) { tooLong = true; pending = []; bytes = 0; }
      if (!tooLong && piece.length) { pending.push(piece); bytes += piece.length; }
      if (nl < 0) break;
      endLine();
      from = nl + 1;
    }
  }
  // At the cap: one byte more says whether the file goes on past it.
  if (readSync(fd, Buffer.alloc(1), 0, 1, offset)) left.pastCap = true;
  else endLine();
  return left;
}

/**
 * `.omelette/reports/<name>`, written whole: a new temp file beside it through
 * O_EXCL | O_NOFOLLOW | O_NONBLOCK, then renamed over the name. `reports/` is
 * made when absent and refused when it is a symlink or not a directory.
 * Returns null, or why nothing was written.
 */
function writeReport(dir, name, text) {
  const reports = join(dir, 'reports');
  let st;
  try { st = lstatSync(reports); } catch (e) {
    if (!e || e.code !== 'ENOENT') return `.omelette/reports cannot be read (${(e && e.code) || 'error'})`;
    try { mkdirSync(reports); st = lstatSync(reports); } catch (e2) { return `.omelette/reports cannot be made (${(e2 && e2.code) || 'error'})`; }
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return '.omelette/reports is not a directory (a symlink is refused)';
  const tmp = join(reports, `.${name}.${process.pid}.${Date.now()}.tmp`);
  let fd = null;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW | NONBLOCK, 0o644);
    const buf = Buffer.from(text, 'utf8');
    for (let at = 0; at < buf.length;) at += writeSync(fd, buf, at, buf.length - at);
    closeSync(fd);
    fd = null;
    renameSync(tmp, join(reports, name));
    return null;
  } catch (e) {
    if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
    try { unlinkSync(tmp); } catch { /* never made */ }
    return `.omelette/reports/${name} cannot be written (${(e && e.code) || 'error'})`;
  }
}

/**
 * THE TOUCHED RECORD (1.8.0): SubagentStop for a guarded role reads the
 * agent's own transcript (`agent_transcript_path`, under the bounds above)
 * and writes `.omelette/reports/touched-<role>-<id first 8>.md` — every path a
 * `Write`, `Edit` or `NotebookEdit` named and every path bashWrites reads a
 * Bash command as writing, once each in first-seen order with the kind it was
 * first seen as, and the tool calls by name. A Bash path written after a `cd`
 * is listed as written, resolved against the cwd, its kind marked `after cd`;
 * one under `/dev/` is not listed. A tool use is counted once by its
 * `id`: the harness also writes `api-request-blob` records that repeat the
 * assistant's tool uses. The session opens the file beside the role's report
 * and compares it with the `## DIFF`.
 *
 * Nothing is refused and nothing goes to stdout: an `additionalContext` would
 * land in the stopped agent's own transcript, which nobody reads (probe P6).
 * A record that cannot be written — a transcript outside the projects
 * directories, one that cannot be opened, no `.omelette/` of ours — is one
 * stderr line. A role nobody guards is not ours: nothing at all.
 */
function subagentStop(event) {
  const started = Date.now();
  const agent = str(event.agent_type);
  if (!GUARDED_AGENTS.has(agent)) return;
  const fail = (why) => say(process.stderr, `omelette-guard: ${why} — no touched record for ${agent}\n`);
  const id = str(event.agent_id);
  if (!AGENT_ID.test(id)) return fail('agent_id is missing or not a plain id');
  const found = ledgerDir(event);
  if (!found || !found.exists) return fail('no .omelette/ directory of ours in the cwd');
  const cwd = resolve(str(event.cwd, process.cwd()));
  const given = str(event.agent_transcript_path);
  const path = given ? resolve(given) : '';
  if (!path || !transcriptAllowed(path)) return fail(`transcript ${clean(given || '(none)')} is not under ~/.claude/projects or $CLAUDE_CONFIG_DIR/projects`);

  const touched = new Map(); // path → the kind it was first seen as
  const counts = new Map(); //  tool name → calls, in first-seen order
  const ids = new Set();
  let malformed = 0;
  let tooDeep = 0;
  const note = (p, kind) => { if (!touched.has(p)) touched.set(p, kind); };
  const onLine = (line) => {
    if (!line.trim()) return;
    let record;
    try { record = JSON.parse(line); } catch { malformed++; return; }
    const content = isObject(record) && isObject(record.message) && Array.isArray(record.message.content) ? record.message.content : [];
    for (const use of content) {
      if (!isObject(use) || use.type !== 'tool_use') continue;
      if (typeof use.id === 'string' && use.id) {
        if (ids.has(use.id)) continue;
        ids.add(use.id);
      }
      const name = str(use.name, 'unknown');
      counts.set(name, (counts.get(name) || 0) + 1);
      const input = isObject(use.input) ? use.input : {};
      if (Object.hasOwn(PATH_TOOLS, name)) {
        const p = str(input[PATH_TOOLS[name]]);
        if (p) note(resolve(cwd, p), name);
      } else if (name === 'Bash') {
        try {
          for (const w of bashWrites(str(input.command), cwd)) {
            // After a cd the path is as written, resolved here: the record says so.
            if (!writesNoFile(w.path)) note(w.path, `bash ${w.kind}${w.name === undefined ? '' : ', after cd'}`);
          }
        } catch (e) {
          if (!(e instanceof TooDeep)) throw e;
          tooDeep++;
        }
      }
    }
  };

  let fd;
  try { fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK); } catch (e) {
    return fail(`transcript ${clean(path)} cannot be opened (${(e && e.code) || 'error'})`);
  }
  let left;
  try {
    if (!fstatSync(fd).isFile()) return fail(`transcript ${clean(path)} is not a regular file`);
    left = readTranscriptLines(fd, started, onLine);
  } catch (e) {
    return fail(`transcript ${clean(path)} could not be read — ${clean(firstLine(e && e.message))}`);
  } finally {
    try { closeSync(fd); } catch { /* already gone */ }
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const skipped = [
    ...(malformed + left.overlong ? [`${plural(malformed + left.overlong, 'line')} (malformed, over 1 MB)`] : []),
    ...(tooDeep ? [`${plural(tooDeep, 'command')} too deep to read`] : []),
    ...(left.pastCap ? ["the file's bytes past 16 MB"] : []),
    ...(left.timedOut ? [`reading stopped at ${TRANSCRIPT_CLOCK_MS / 1000} s`] : []),
  ];
  // Most calls first; a stable sort keeps first-seen order among equals.
  const tally = [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${clean(name)}: ${n}`);
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const text = [
    `# touched — ${agent} ${id}`,
    '',
    `transcript: ${clean(path)}`,
    ...(skipped.length ? [`skipped: ${skipped.join('; ')}`] : []),
    '',
    ...[...touched].map(([p, kind]) => `- ${shown(cwd, p)} (${kind})`),
    ...(touched.size ? [''] : []),
    `tool calls: ${total}${tally.length ? ` (${tally.join(', ')})` : ''}`,
    '',
  ].join('\n');
  const why = writeReport(found.dir, `touched-${agent}-${id.slice(0, 8)}.md`, text);
  if (why) fail(why);
}

const event = await readEvent();
// Wrapped whole: nothing this guard reads — a cwd that is not a directory, a
// ledger that changed under it, a stream that went away — may reach the harness
// as a crash. A PreToolUse refusal is the ONE non-zero exit here, and it has
// already set the code by the time anything can throw.
try {
  if (event) {
    const name = str(event.hook_event_name);
    if (name === 'PreToolUse') await preToolUse(event);
    else if (name === 'PreCompact') await preCompact(event);
    else if (name === 'SessionStart') await sessionStart(event);
    else if (name === 'SubagentStop') subagentStop(event);
    // Anything else: this guard has no opinion about it.
  }
} catch { /* a guard that crashes is a session that stops working */ }
