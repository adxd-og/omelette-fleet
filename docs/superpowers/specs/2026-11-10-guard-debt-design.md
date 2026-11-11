# The guard debt — the passes 1.9.0 left documented, closed; three rules sentences with them

**Status:** approved by the operator 2026-11-10 in chat («Делаем», then «Все по рекомендациям» for D1–D3) · **Base:** main `7151c4b` · **Version:** 1.10.1 (new refusals in a shipped hook, no new tool, key or role — a patch through the full flow, as 1.7.2 was) · **Branch:** `feat/guard-debt` · **Ledger:** `.omelette/ledger-guard-debt.md`

| Question | Where |
|---|---|
| What passes today, measured | [What is measured](#what-is-measured) |
| The line the guard draws, and why these four fall inside it | [The principle](#the-principle) |
| awk and sed heredocs | [1. Heredoc bodies](#1-heredoc-bodies) |
| A heredoc inside an open group, piped after it | [2. A body inside an open group](#2-a-body-inside-an-open-group) |
| `git config` and `git -c` | [3. Config](#3-config) |
| `checkout` of paths, `restore`, `clean`, a forced switch | [4. Work thrown away](#4-work-thrown-away) |
| The three rules sentences | [5. Rules text](#5-rules-text) |
| Which files change | [6. Delivery](#6-delivery) |
| Tests | [7. Tests](#7-tests) |
| Who does what, in which order | [8. Who does what](#8-who-does-what) |
| What is deliberately not in it | [Non-goals](#non-goals) |
| What is decided, and what waits for the operator | [Decisions](#decisions) |
| When it is done | [Done-when](#done-when) |

## What is measured

The rendered 1.10.0 guard (`.claude/hooks/omelette-guard.mjs`), fired as `omelette-coder`, 2026-11-10. Every line below **passes** today.

| Class | Command (body or tail: `git commit -m x` where one is shown) |
|---|---|
| Heredoc to a program that runs it | `awk -f /dev/stdin <<'EOF'` · `awk -f - <<'EOF'` · `sed -f - f <<'EOF'` (GNU `e`) · `awk 'BEGIN{system("sh")}' <<'EOF'` |
| Heredoc in an open group | `(cat <<'EOF'` … `EOF` `) \| sh` · `{ cat <<'EOF'` … `EOF` `} \| sh` · `if true; then cat <<'EOF'` … `EOF` `fi \| sh` |
| Config | `git config core.fsmonitor /tmp/x.sh` · `git config --global core.hooksPath /tmp/h` · `git config alias.ci commit` · `git config set …` · `git config --unset …` · `git -c alias.ci=commit ci -m x` · `git --config-env=alias.ci=X ci` · `git -c "$X" status` |
| Work thrown away | `git checkout -- .` · `git checkout HEAD -- .` · `git checkout .` · `git checkout -f main` · `git switch -f main` · `git switch --discard-changes main` · `git restore .` · `git restore --source=HEAD~1 -- .` · `git clean -fd` · `xargs git restore < files` |

Already refused, kept as they are: `git reset --hard`; `awk 'BEGIN{system("git commit -m x")}' f` and `sed -n '1e git commit -m x' f` (the program text is a quoted word, re-read); `cat <<'EOF' | sh`; `timeout 5 sh -c "git commit"`.

## The principle

The guard refuses what leaves the session's check blind: a write to history, a ref, a stash or a worktree, and a tree rewritten so that `git status --porcelain` reads clean (`reset --hard`, 0.3.4). Two things follow, and nothing wider:

- **A command the guard cannot name is a write it cannot see.** A heredoc body run by `awk` or behind a group's pipe, and a subcommand renamed by an alias on the same line, reach `commit` without spelling it where the guard reads.
- **Work thrown away or config left behind outlives the role.** `checkout -- .`, `restore`, `clean` remove the diff the session is about to review, and status shows nothing; a config write stays in the operator's repository or home and runs later, in their own git.

It stays containment for a role that is asked to behave, not a security boundary — the header and SECURITY say so and keep saying it.

## 1. Heredoc bodies

`awk` and `sed` leave `NON_EXEC`: a heredoc body on a line that runs either is read as a command, as it is for `python3` or `sh`.

- **Why the whole program and not `-f -`:** `awk 'BEGIN{system("sh")}' <<'EOF'` runs the body through an inherited stdin with no `-f` on the line. No flag separates the forms.
- **The price, accepted:** `sed s/a/b/ <<'EOF'` and `awk '{print $1}' <<'EOF'` are refused when the body holds git-write text. The way round is the one SECURITY already gives: the Write tool, or the text kept out of the body.
- `less`, `more`, `tar`, `cpio` stay in the set: none runs a text body, and `--to-command` on the line is a word the guard reads.

## 2. A body inside an open group

A heredoc whose line stands inside a group that is still open at that line's end — `(`, `{`, or a compound command (`if`, `while`, `until`, `for`, `case`, a function body) — has its body read as a command: what the group's output feeds is written after the body, where `lineFeeds` has already answered.

- It fails closed, like the rest of the heredoc rule: the guard does not look ahead for the pipe.
- The line is read as a line that feeds: its substitutions and quoted words too, as on a line that pipes to `sh` (`( echo "$(cat <<'EOF'` … `EOF` `)"` + `) | sh` is the same body one level down). Ruled by the session at T1's review, 2026-11-11.
- **The price:** a `cat <<'EOF'` inside a loop, an `if` or a function, with git-write text in the body, is refused. `while read …; done <<'EOF'` is refused today for another reason and stays so.

## 3. Config

**`git config` is read by its arguments, and only a read passes.**

| Form | Verdict |
|---|---|
| A write word anywhere: `--add`, `--replace-all`, `--unset`, `--unset-all`, `--rename-section`, `--remove-section`, `-e`/`--edit`; or the first positional `set`, `unset`, `rename-section`, `remove-section`, `edit` | refused |
| A read mode: `--get`, `--get-all`, `--get-regexp`, `--get-urlmatch`, `--get-color`, `--get-colorbool`, `-l`/`--list`; or the first positional `get`, `list` | passes |
| The bare form: one positional (`git config user.name`) | passes — a read |
| The bare form: two or more positionals (`git config user.name x`) | refused — a write |
| A positional the shell may split or drop (an unquoted expansion or substitution) | refused unread |
| Fed by `xargs` | refused, as `tag` and `branch` are |

Valued options (`-f`/`--file`, `--blob`, `--type`, `--default`, `--value`, `--url`, `--comment`) are stepped over with their values, attached or detached; a write word wins over a read mode on the same line.

**Amended at T2's review (2026-11-11, measured on git 2.38.1):** `git config` stops reading options at its first positional, so a read mode or a write word counts only BEFORE it — `git config core.fsmonitor /tmp/x.sh --get` is a write of two values and is refused by the count, `git config --get a.b --unset` is a read with a pattern; a long option is matched by its unambiguous prefix, valued ones included (`--fil` takes the next word); an argument that holds a brace expansion is refused unread, read mode or not (`git config {--unset,a.b}`).

**`git -c` and `--config-env`: the key is read, and three sections are refused** — `alias.*`, `include.*`, `includeIf.*` (case-insensitive, as git reads them). An alias renames a subcommand the guard would have refused; an include brings a file of them.

- A `-c` whose key cannot be read — an expansion or substitution before the `=`, or the whole value (`-c "$X"`) — is refused unread. `-C "$DIR"` is untouched.
- **Every other key passes**, `core.hooksPath`, `core.fsmonitor`, `core.pager` and `core.sshCommand` included: on the command line they run a program for one invocation, which the role can run directly; the guard does not read what a script does. Saved by `git config` they are refused with every other write.
- A `git config` or a `-c alias` refusal has its own sentence (below), so the role reads what it was caught for.

## 4. Work thrown away

One rule, taken from `reset --hard`: a form that rewrites tracked files from the index or a commit, or deletes untracked ones, is refused; a form that only moves between branches or only touches the index passes.

| Subcommand | Refused | Passes |
|---|---|---|
| `checkout` | any word behind a bare `--`; `-f`/`--force`; `--ours`, `--theirs`; `-p`/`--patch`; `--pathspec-from-file`; two or more positionals (`checkout HEAD file`); one positional that reads as a path: `.`, `..`, a word opening with `./`, `../`, `/`, `~` or `:`, a glob | `checkout <ref>`, `checkout -` , `checkout --detach <ref>`, `-m`/`--merge` (it keeps local changes) |
| `switch` | `-f`/`--force`, `--discard-changes` | every other form the branch rule already passes |
| `restore` | every form but the one on the right; fed by `xargs` | `--staged`/`-S` without `--worktree`/`-W`: the index moves, the file stays, status shows it |
| `clean` | every form but the one on the right; fed by `xargs` | `-n`/`--dry-run` |

- The branch-creation reading of `checkout` and `switch` is unchanged and still decides first.
- **One positional that is a plain word stays allowed** (`git checkout main`), and with it the residual: where no ref `docs` exists and a tracked `docs` does, `git checkout docs` restores that path. The guard does not read the filesystem to tell them apart ([D2](#decisions)).
- **The refusal sentence** for sections 3 and 4, beside the existing one: the role name, what the class is (`discards work in the tree` / `writes git config`), `report instead`. Wording is the plan's.

## 5. Rules text

Three sentences in `rules/omelette-fleet.md`, each changed in every place the file states it (binding ruling, DECISIONS:45).

| Where | Adds |
|---|---|
| Tester flow, step 6, after "a new finding to the operator" | a report that holds both — the same finding still standing and a new one — sends the whole task to the operator; no `xhard` round starts while a new finding waits |
| Reviews, "one fix dispatch for all its findings" | save a finding in code a Fable coder built or fixed, which goes to the operator (step 6) |
| Operating model, "Branch per feature; main is gated" | the branch is pushed and seen green on CI before the merge, where the project has CI and pushing is the session's |

`docs/ORCHESTRATION.md` gets the same three in its own words; the rules cap moves by the measured growth plus 150, with its dated comment.

## 6. Delivery

| Area | Files |
|---|---|
| Guard | `hooks/omelette-guard.mjs` — `NON_EXEC`; `lineFeeds` and the tokenizer's group depth; `WRITES_BY_ARGUMENTS` gains `config`, `restore`, `clean`; the `checkout` and `switch` readers; the global-option walk reads a `-c` key; `FED_BY_XARGS_WRITES`; the second refusal sentence; the header comment |
| Rules | `rules/omelette-fleet.md`, `test/rules-size.test.mjs` |
| Docs | `SECURITY` (the subcommand table, "How the command string is read", Residuals: the closed lines out, the new ones in), `ORCHESTRATION` (the three sentences, the guard layer's list), `CHANGELOG` with the upgrade line `rules --hooks`, `MEASUREMENTS` (the hard coder's row) |
| Version | `package.json` 1.10.1 |

The mod runs the project's rendered script, so there is one guard to change; an install keeps the old one until `rules --hooks` re-renders it.

## 7. Tests

Each pins a line of this spec through the rendered guard; none reads source text. Every refusal has a neighbour that passes.

- Section 1: each measured awk and sed line is refused; `sed s/a/b/ <<'EOF'` with a harmless body passes; `cat > f <<'EOF'` with git-write text still passes.
- Section 2: the three measured group lines are refused; the same groups with a harmless body pass.
- Section 3: every row of the `git config` table, both spellings (`--unset` and `unset`); `-c alias.x=…`, `-c Alias.X=…`, `--config-env=alias.x=V`, `-c include.path=f`, `-c "$X"` refused; `-c user.name=a log`, `-c core.pager=cat log`, `-C "$DIR" status` pass.
- Section 4: every cell of the table, the cluster forms (`-qf`, `-SW`) and a bare `--` included; `checkout main`, `checkout -`, `switch main`, `restore --staged f`, `clean -n` pass.
- The second refusal sentence names the role and the class.
- The linear-scan budgets of the heredoc tests hold with the group depth counted (budget at ×3 of the local time). Amended at the release's fix round: ×3 went red twice on shared CI runners (958 ms against 800, 1331 against 1300), so a linear-time row's budget is at most ×10 of the local time, and a fifth of its quadratic's time where one was measured.
- The rendered rules file fits the new cap.

## 8. Who does what

| Task | Who |
|---|---|
| T1 sections 1 and 2 — the heredoc rule (`hard` bucket: parser logic) | `omelette-coder-hard`, then `omelette-tester` with the second pass |
| T2 section 3 — config | `omelette-coder`, tester |
| T3 section 4 — work thrown away, the refusal sentence | `omelette-coder`, tester |
| T4 rules sentences and the cap | the session, tester's suite run |
| T5 docs, CHANGELOG | a cheaper model, session review |
| Reviews before merge | Opus whole-branch, Grok, Mistral `mistral_security_review` on the guard diff, Codex as far as the free tier allows — say so; the branch is pushed to CI before the merge |

T1 is the measurement 1.10.0 promised: tokens, wall clock, fix rounds and review findings of the hard coder's task go to MEASUREMENTS beside 1.9.0's heredoc task (unmatched, N = 1, said so).

## Non-goals

- **No environment route:** `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`, `GIT_CONFIG_GLOBAL`, `GIT_SSH_COMMAND` pass (measured) and go to Residuals — an alias the role did not write on the line is out of scope already.
- **No plumbing:** `git checkout-index -f -a` and `git read-tree -u --reset` pass (measured) and go to Residuals.
- **No `git rm`, no plain `rm`:** a deletion shows in `git status`.
- **No allowlist of `-c` keys** and no reading of what a hook or a pager script does.
- The other guard tails of the backlog stay there: the failed intermediate `cd`, `a[1]=(x)#x`, `git co{m,}mit`, `timeout` among the wrappers, the hook's refusal counter.
- The other rules tails stay there: a new role name needs a restarted session; a `/clear` ends a sub-agent's continuation; the re-review report's name.

## Decisions

| # | What | Who, when |
|---|---|---|
| — | A release-review finding in code a Fable coder built or fixed goes to the operator; the release's other findings ride the one fix dispatch | operator, 2026-11-10 («решали же, что ведёт к оператору») |
| — | A report with the same finding standing and a new one sends the whole task to the operator; `xhard` does not start | operator, 2026-11-10 («Делаем») |
| D1 | Section 2 is in this patch — it is the second half of the residual SECURITY:441 names, measured passing, and backlog row 9 does not list it | session's recommendation, operator 2026-11-10 («Все по рекомендациям») |
| D2 | `git checkout <one plain word>` is not checked against the filesystem — a verdict that depends on what the tree holds is harder to test and to explain; the residual is one path, not the tree | session's recommendation, operator 2026-11-10 |
| D3 | `-c` refuses three sections, not everything outside an allowlist — an allowlist over-refuses the `-c core.quotepath=off`, `-c color.ui=never`, `-c init.defaultBranch=main` a role writes daily | session's recommendation, operator 2026-11-10 |
| D4 | 1.10.1, a patch | session, by 1.7.2's precedent |

## Done-when

- `npm test` pristine, CI green on the pushed branch, reviews ruled, merged, tagged `v1.10.1`, released, managed files re-rendered here (`rules --agents --hooks`).
- Live gate: every line of [What is measured](#what-is-measured) is refused by the rendered guard here, and the "already refused" and "passes" neighbours are unchanged; the vendor matrix row and the units-per-release line are in MEASUREMENTS, with the hard coder's row.
