# Docs pass — a README a newcomer can read, an audit of the set, two charts

**Status:** shape agreed in chat by the operator 2026-11-04 ("просто апдейт доков", no version bump); this spec awaits the operator's approval · **Base:** main `0d56fce` (v1.8.0 + three docs commits) · **Branch:** `feat/docs-pass` · **Ledger:** `.omelette/ledger-docs-pass.md`

No behaviour changes. No new tools, keys or hooks. No version bump; the next release's CHANGELOG entry carries one line for it.

| Question | Where |
|---|---|
| What is wrong with the docs today? | [Why](#why) |
| What does the audit check, and who runs it? | [1. The audit](#1-the-audit) |
| What does the new README hold, and where does the rest go? | [2. The README](#2-the-readme) |
| Which pictures are added, and from what data? | [3. Visuals](#3-visuals) |
| Which tests change? | [4. Tests](#4-tests) |
| Who does what, in which order, and how is it reviewed? | [5. Who does what](#5-who-does-what) |
| What is deliberately not in it? | [Non-goals](#non-goals) |
| When is it done? | [Done-when](#done-when) |

## Why

Read 2026-11-04 on main `0d56fce`:

- **README is a doc, not the map of the set.** 413 lines, 50 KB; it carries a full `doctor` dump from 1.7.3, the whole CLI table, a config file, the three-layer table of how rules reach a session, and a FAQ whose longest answer is about which Codex ids a ChatGPT plan accepts. A newcomer reads 150 lines before the first command. The operator's rule since 2026-09-10 is that README maps the docs and each doc opens with a map.
- **The set is 463 KB and nobody has audited it against the code since 1.0.0.** ORCHESTRATION (91 KB) and SECURITY (89 KB) grew by a release each time; 1.8.0 alone touched six docs in a fix round. The 1.0.0 docs pass found eight real defects in a docs-only release; three releases of guard and ledger work have landed since.
- **The pictures exist and are under-used.** Ten diagrams in `docs/assets/diagrams/` (HTML source + SVG export, one style), README embeds one. MEASUREMENTS holds two tables that are charts waiting to be drawn: review yield per release (ten rows) and the test suite's size per release.

## 1. The audit

One pass over every doc before anything is rewritten, so the rewrite carries no stale claim forward.

- **Scope:** README (claims inventory only — it is rewritten in §2), ORCHESTRATION, CONFIG, SECURITY, ADAPTERS, ARCHITECTURE, STATUS-FEED, MODS, MEASUREMENTS. DECISIONS and CHANGELOG are not audited (a register and a log).
- **What each auditor checks, per doc:**
  1. **Claims against the code.** Every command, flag, key name, default value, path, exit code, version string and "the guard refuses X" sentence is opened against `bin/`, `core/`, `hooks/`, `units/`, `mods/` or a test. A claim with no code behind it is a finding; a number that moved (`1.7.3` in an example, `25 lines` in a register count) is a finding.
  2. **The map against the sections.** Every map row points at a section that answers its question; every top-level section has a row; the anchors resolve (the test covers resolution, not relevance).
  3. **Prose that should be a table or a picture.** Paragraphs over six lines that enumerate (keys, verdicts, steps, events) are listed with a proposed shape.
  4. **Duplicates.** Text that README also carries verbatim or nearly, so §2 knows what moves and what is deleted.
  5. **Dead references.** Links to sections that moved, tools renamed, options that no longer exist.
- **Report shape:** `.omelette/reports/docs-audit-<doc>.md`, findings only, each in four parts (`location · scenario · consequence · how to confirm`) with a pointer line in `check`'s grammar for the doc line and one for the code line it contradicts; `omelette-fleet check` must read every pointer. Plus a closing block `## MOVE CANDIDATES` (for §2) and `## SHAPE CANDIDATES` (for item 3).
- **Who:** one Sonnet-class sub-agent per doc for the three big ones (ORCHESTRATION, SECURITY, CONFIG); one for ADAPTERS + ARCHITECTURE + STATUS-FEED; one for MODS + MEASUREMENTS; one for README's claims inventory. Six, in parallel, `effort: high`, read-only (the brief forbids edits; the guard records what they touch). A Grok `grok_code_review` sweep on each of the three big docs as a second reader (local-only profile, narrow brief: "sentences that contradict the code under these paths"); every Grok claim is checked by the session before it counts.
- **Rulings:** the session rules each finding `verified` / `rejected` / `needs-check` in the ledger. Fixes are applied per doc by one Sonnet-class docs agent from the verified list (one brief per doc, one commit per doc: `docs: <DOC> — audit fixes (<n>)`). A fix that changes a sentence a test pins changes the test in the same commit.

## 2. The README

README becomes the front door and the map; everything a reader needs after the first ten minutes lives in a doc it points at.

**Target:** 120–150 lines, under 15 KB, three pictures, one code block per command the reader types.

**Sections, in order:**

1. **Header** — logo, badges (unchanged).
2. **One paragraph:** what it is (three read-only research and review peers — Gemini, Grok, Codex — inside Claude Code, on the subscriptions you already pay for, driving each vendor's own CLI), who it is for, the one rule (units propose, the session applies).
3. **The picture** — `fleet-topology.svg` (exists).
4. **Quickstart** — five commands, nothing between them but one line each: clone, `install`, `cd` to the project, `rules --agents --hooks`, `doctor`. Then one sentence: restart Claude Code, merge the printed snippet, run `doctor` again. A link to INSTALL for everything else.
5. **What you can ask it** — a six-row table: task → tool (research, deep research, cheap second opinion, strongest code review, images, a lost answer via `<unit>_result`). The routing table's short form.
6. **How a session works with it** — `operating-model.svg` (exists) and four lines: the session orchestrates, the coder codes, the tester tests with the real diff, the units propose; the guard refuses a sub-agent's commit. Link to ORCHESTRATION.
7. **Is it really read-only?** — three bullets (closed by default, two keys to open it, strength differs by vendor: kernel for Codex, policy for Gemini, refused for Grok). Link to SECURITY.
8. **Documentation** — the map of the set: the existing `| If you want to know… | Read |` table plus INSTALL's rows. README's own `| Question | Where |` map stays directly under the header, inside the test's 60-line window, as today; the docs-set table sits here, below the quickstart, and the test stops requiring it in the first 60 lines (§4).
9. **FAQ** — five questions, each answered in at most four lines: why CLIs and not API keys; why read-only; can a unit write; how it compares to codex-plugin-cc and pal; how to add a unit. The long answers move (below).
10. **License.**

**Where the rest goes** (nothing is deleted; every fact survives in one place):

| Today in README | Goes to |
|---|---|
| Quickstart's long form (what `install` registers, `--rules`, prefixes, the watcher, the contract line, the hooks snippet, the mods pointer) | **new `docs/INSTALL.md`**, "Install, wire, check, update" — with its own map |
| What doctor tells you (the dump, the line table, the `next` ladder, `--probe-sandbox`) | INSTALL, "What doctor tells you" — the dump re-taken on the day from a 1.8.0 install, trimmed to the lines the table names |
| Fewer permission prompts | INSTALL |
| CLI table | INSTALL, "CLI" (the table as is) |
| Keeping it up to date | INSTALL |
| Units table (CLI, log in with, tools, good for, do not trust it with) | split: "log in with" → INSTALL; "tools / good for / do not trust" → the six-row table in README §5 for the short form, the full row → ORCHESTRATION's routing section (which already carries most of it — the audit's duplicate list decides what is merged, not copied) |
| Configuration (the example file, the Codex `--ignore-user-config` consequence) | CONFIG already carries both (the audit confirms; if a sentence is not there, it moves) |
| Security (five bullets) | three stay (§7), the allowlist and the untrusted-input bullets are SECURITY's opening lines already |
| Status feed | one sentence in README §5's footnote + STATUS-FEED (unchanged) |
| Orchestration — the three-layer table and the `/omelette-test` paragraph | ORCHESTRATION, "How the rules reach a session" (exists; merge, do not duplicate) |
| FAQ: "What if my ChatGPT plan rejects a Codex model?" | ORCHESTRATION, "Model and effort escalation" (which it already links) |
| FAQ: "Why three servers instead of one?" | ARCHITECTURE |

**Voice:** short sentences, the reader addressed as "you", one idea per sentence, no clause chains; a term is explained the first time it appears (unit, session, guard, ledger). English, as the rest of the docs. The `prose-no-slop` mechanical rules apply to the new text.

## 3. Visuals

- **README** embeds three existing SVGs: `fleet-topology` (what), `operating-model` (how you work with it), and `call-path` (one call, from ARCHITECTURE — stays embedded there too; the test allows multiple embeds). No new diagram for README: the three cover what, how, and one call.
- **Two charts in MEASUREMENTS**, generated, not drawn by hand, so a release can re-run them:
  - `docs/assets/charts/review-yield.svg` — per release: found / accepted / rejected, stacked bars, from the "Review yield per release" table.
  - `docs/assets/charts/test-suite.svg` — per release: tests in the suite (the numbers the "test suite before and after the clean-up gate" section holds, plus 1.8.0's 1855).
  - A script `scripts/docs-chart.mjs` modelled on `scripts/eval-chart.mjs` (eval-chart's own conventions, so the six charts read as one set: its palette, no painted background, a dark-mode `<style>`, `data-*` on marks; no `@import`, no external font — the diagrams' ink/paper/accent palette is for diagrams), with the data as a literal at the top and a comment naming the table it mirrors; `node scripts/docs-chart.mjs` rewrites both files. The `dataviz` skill's rules apply (one accent, labelled axes, the number on the bar where it matters).
- **One optional screenshot** of the fleet pane for MODS.md, if the operator supplies one from a session without personal data (no home paths, no e-mail): `docs/assets/pane.png`, under 300 KB. Skipped without a ledger line if none arrives.
- **Alt text** on every embed says what the picture shows in one sentence (the test checks presence, the session checks truth against the code, as in 1.0.0 — three of six alt texts were wrong then).

## 4. Tests

- `test/docs-map.test.mjs`: INSTALL joins the list of docs that open with a map; the README docs-set table is found anywhere in the file (today: within the first 60 lines), while README's own `| Question | Where |` map keeps the 60-line window; `docs/assets/charts/*.svg` follows the same rules as the diagrams (offline, `viewBox`, embedded somewhere).
- `test/perimeter-docs.test.mjs`: the `| **gemini** |` row assertion follows the row to its new file (INSTALL or ORCHESTRATION, whichever the move in §2 lands on).
- `test/docs-anchors-1.6.1.test.mjs`: unchanged; it is what catches a moved section.
- A new pin: README is under 160 lines and under 16 KB (`test/docs-map.test.mjs`, one `test(...)`) — the number that keeps the front door from growing back.
- `npm test` green on macOS and on Linux (CI on the pushed branch) before the merge.

## 5. Who does what

| Step | Who | Output | Commit |
|---|---|---|---|
| 1. Audit | 6 Sonnet sub-agents (`general-purpose`, `model: sonnet`, `effort: high`, read-only brief) + 3 Grok sweeps | `.omelette/reports/docs-audit-*.md`, rulings in the ledger | — |
| 2. Audit fixes | 1 Sonnet docs agent, one brief per doc from the verified list | per-doc fixes | one per doc |
| 3. README + INSTALL | 1 Opus sub-agent (`omelette-coder`, `effort: xhigh` — it is a judgement task: what a newcomer needs, what moves where); brief = this §2 + the audit's MOVE CANDIDATES + the current README | README, INSTALL, the moved paragraphs in their new homes | README; INSTALL; one per doc receiving moved text |
| 4. Charts + embeds | 1 Opus sub-agent (`omelette-coder-medium`: the shape is written) | `scripts/docs-chart.mjs`, two SVGs, the embeds, alt texts | script + charts; embeds |
| 5. Tests | the session, small-change exception (each edit under 20 lines with its check) | §4 | one |
| 6. Review | one `omelette-reviewer` whole-branch read (brief: stale claims, maps vs sections, alt text vs code, every moved fact still present once) + **the cold-reader test**: a fresh Haiku sub-agent gets the new README and nothing else and is asked to say what the product is, how to install it, and what it must not trust — where its answer is wrong or empty, README is | `.omelette/reports/docs-pass-review.md`; the cold read in the ledger | fixes: one dispatch for all findings |
| 7. Merge | the session merges `feat/docs-pass` into main (ff) after the review is clean and CI is green; push on the operator's word | — | — |

The session reviews every output before it is accepted; the ledger gets `BASE` before each coder dispatch and a `review yield` line at the close.

## Non-goals

- No rewrite of ORCHESTRATION, SECURITY or CONFIG for length — only the audit's fixes and the paragraphs README hands them. A second pass that shrinks them to maps is a separate plan (backlog).
- No change to the rules template, the agent definitions or the skill (managed files, not docs).
- No Mermaid, no PNG diagrams, no dark-mode variants; the existing SVG pipeline and palette stay.
- No translation: the docs stay English; a Russian README is not in this pass.
- No version bump, no tag, no GitHub release.

## Done-when

- Every audit finding has a ruling; every verified one is fixed and its commit named in the ledger.
- README: under 160 lines and 16 KB, three pictures, the five-command quickstart, the docs-set map; every fact it dropped is found once in the doc the table in §2 names (the reviewer's checklist).
- `docs/INSTALL.md` exists, opens with a map, and README's documentation table points at it.
- Two charts render on GitHub (offline SVG), their numbers equal the tables they mirror, `node scripts/docs-chart.mjs` reproduces them byte for byte.
- `npm test` green locally and on Linux CI; `omelette-fleet check` reads every audit report; the cold-reader test answers the three questions correctly.
- The ledger closes with the review yield and a handoff; the branch is merged and deleted; the next release's CHANGELOG entry gets its line.
