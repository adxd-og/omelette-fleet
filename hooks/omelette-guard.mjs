{{marker}}
/**
 * omelette-fleet :: the guard hook, one script for three events.
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
 * PreCompact — the ledger's re-read stamp. A compaction is where a plan loses
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
 * The two ledger hooks answer to one switch, `handoff.enabled`, rendered into
 * this script as a literal (HANDOFF_CONFIG below): false turns the stamp and
 * the print off, and the git guard runs whatever it says.
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
 * user.name="A B"`) and a long flag (`--work-tree /tmp/x`) — unless that word
 * opens with `-`, which leaves the flag without one. GLOBAL_FLAG needs nothing
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
 * @returns {object} `{ tokens, spans }`: each token `{ text, quoted, separator }`,
 *   each span a text to read again as a command — a quoted word with its quotes
 *   off, or what a command or process substitution runs
 */
function tokenize(command) {
  const tokens = [];
  const spans = [];
  let text = '';
  let quoted = false;
  let quote = '';
  let redirect = false; // the next word is a redirection's target
  const push = () => {
    if (!text) return;
    if (!redirect) tokens.push({ text, quoted, separator: false });
    const plain = unquote(text); // only a word that held a quote loses a character here
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
      if (c === '&') i++; //                             `&>`, `&>>`: the `>` comes next
      const follows = (chars) => i + 1 < command.length && chars.includes(command[i + 1]);
      if (command[i] === '>' && follows('>|&')) i++; //                     `>>`, `>|`, `>&`
      else if (command[i] === '<' && follows('<')) { i++; if (follows('<-')) i++; } // `<<`, `<<<`, `<<-`
      else if (command[i] === '<' && follows('>&')) i++; //                 `<>`, `<&`
      redirect = true;
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
      continue;
    }
    if (/\s/.test(c)) { push(); continue; }
    text += c;
  }
  push(); // a quote the command never closed runs to its end, inside the last word
  return { tokens, spans };
}

/** A word that ends in `git` where a word begins — `git`, `/usr/bin/git`, `(git` — which is where an invocation can start. */
const isGitWord = ({ text, separator }) => !separator && text.endsWith('git') && !/\w/.test(text.charAt(text.length - 4));

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
    const { text } = tokens[j];
    if (GLOBAL_VALUED.test(text) && !GLOBAL_NO_VALUE.has(text)) {
      j++;
      if (isWord() && !tokens[j].text.startsWith('-')) {
        if (SUBCOMMAND.test(tokens[j].text)) fallback = j;
        j++;
      }
    } else if (GLOBAL_FLAG.test(text) || GLOBAL_NO_VALUE.has(text)) j++;
    else break;
  }
  const sub = isWord() ? SUBCOMMAND.exec(tokens[j].text) : null;
  if (sub) return { name: sub[1], from: j + 1 };
  return fallback < 0 ? null : { name: SUBCOMMAND.exec(tokens[fallback].text)[1], from: fallback + 1 };
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
  const { tokens, spans } = tokenize(withoutComments(raw));
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
const HANDOFF = 'HANDOFF: re-read .omelette/ledger-*.md before continuing.';

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
 * package — it is copied into a project as one file — so the operator's
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

/** This project's ledgers, sorted — the same set PreCompact stamps and SessionStart prints. */
function ledgerNames(dir) {
  try { return readdirSync(dir).filter((f) => /^ledger-.*\.md$/.test(f)).sort(); } catch { return []; }
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
 */
function appendToLedgers(found, text) {
  for (const name of (found.exists ? ledgerNames(found.dir) : [])) {
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

/** Mark every ledger in this project, then say so on stdout — unless `handoff.enabled` is false. */
function preCompact(event) {
  if (!AUTO_HANDOFF.enabled) return;
  const found = ledgerDir(event);
  if (!found) return; // a `.omelette` that is not ours to write: no marker, and nothing to announce
  appendToLedgers(found, `\n## Compaction ${new Date().toISOString()} (trigger: ${triggerOf(event)}) — re-read this ledger before continuing\n`);
  // No ledger — no `.omelette`, or one without a `ledger-*.md` — means nothing
  // was stamped, so nothing is announced: the ledger is the opt-in.
  if (!found.exists || ledgerNames(found.dir).length === 0) return;
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
 * Nothing to print is printed as nothing: no header, no blank line, exit 0 —
 * and nothing at all is read while `handoff.enabled` is false.
 */
function sessionStart(event) {
  if (!AUTO_HANDOFF.enabled) return;
  if (str(event.source) !== 'compact') return;
  const found = ledgerDir(event);
  if (!found || !found.exists) return;
  const ledgers = ledgerNames(found.dir);
  if (!ledgers.length) return;

  // One byte wider than the tail, because the read starts one byte EARLY.
  const buf = Buffer.alloc(LEDGER_READ_MAX + 1);
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
        // THE READ STARTS ONE BYTE EARLY: `^` is a line start only where a
        // line ended, and a tail that opens in the middle of a line would make
        // `## Handoff` out of the rest of one — an escaped `\## Handoff`, as the
        // compaction summaries of 0.3.7–1.4.0 left them in a ledger, is exactly
        // that shape. A newline in that byte means the tail opens a line of its
        // own; anything else means the first line is the tail of an older one
        // and goes, the newline itself kept so the next line still starts one.
        const from = offset > 0 ? offset - 1 : 0;
        text = buf.subarray(0, readSync(fd, buf, 0, Math.min(buf.length, st.size - from), from)).toString('utf8');
        if (offset > 0 && text[0] !== '\n') {
          const nl = text.indexOf('\n');
          text = nl < 0 ? '' : text.slice(nl);
        }
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
