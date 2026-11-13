# 1.10.2 — pin agy's agent mode: a headless research run no longer starts in Auto

Status: approved by the operator, 2026-11-13. Ledger: `.omelette/ledger-agy-mode-pin.md`, branch `feat/agy-mode-pin`.

| Section | Answers |
|---|---|
| [Why](#why) | What changed under the unit, and what was run to see it |
| [Exposure](#exposure) | What a research call can do today |
| [Change](#change) | The one flag, and where it goes |
| [Docs](#docs) | Which sentences stop being true |
| [Tests](#tests) | What gets pinned |
| [Release](#release) | Reviews and the live gate |
| [Not in 1.10.2](#not-in-1102) | What stays out |
| [Open](#open) | What the build has to find out |

## Why

agy auto-updates. Its changelog for **1.5.7**: "Changed the default `Agent Mode` from Default to Auto: sessions with no saved mode, including headless `-p` runs, now start in Auto wherever Auto mode is available … to keep the previous behavior, choose Default for `Agent Mode` in `/config`, which saves `"agentMode": ""` to `settings.json`." Auto mode, from the 1.3.5 entry: it "approves file edits and safe commands without asking".

The unit spawns research with no `--mode` (`units/gemini/adapter.mjs:319`), and its read-only posture is written as "Research runs in agy's STANDARD mode: any tool that would prompt is auto-denied headless" (`units/gemini/adapter.mjs:36`). The operator's `settings.json` holds no `agentMode`.

Run by the session on 2026-11-13, agy 1.5.8, in a scratch directory, with the unit's own argv (`-p <prompt> --output-format json --print-timeout 90s --disable-slash-commands --model "Gemini 4 Hydrogen (Low)"`), the prompt asking for `touch marker.txt` — a `command` the operator's allow list does not hold:

| argv | Result |
|---|---|
| as the unit sends it | `status: SUCCESS`, "ran and exited with code 0", `marker.txt` on disk |
| the same plus `--settings '{"agentMode":""}'` | empty response, `denied_actions: [command]`, stderr "a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied", no file |

`--settings` is "Settings for this session only, never saved" (`agy --help`, 1.5.8): the operator's file is not touched.

## Exposure

Since the machine took agy 1.5.7, `gemini_research` and every stage of `gemini_deep_research` run in Auto: file edits and the commands Auto calls safe are approved with nobody asked. The run reads untrusted web pages by design. Without a `cwd` it sits in a fresh empty directory; with one, it sits in the project. The preamble's "no terminal commands" is a sentence in a prompt, not a refusal.

`gemini_image` and workspace-write research pass `--mode accept-edits` explicitly and are not moved by the new default.

**Until the release:** agy `/config` → `Agent Mode` → Default writes `"agentMode": ""` and closes it for every session on this machine. That is the operator's file and the operator's choice; it also changes interactive agy sessions.

## Change

`runAgyRaw` (`units/gemini/adapter.mjs:317`): a spawn that does not pass `--mode accept-edits` passes `--settings` with `{"agentMode":""}`. One constant next to the argv, named for what it does (`DEFAULT_MODE_PIN`), JSON built with `JSON.stringify`.

- An accept-edits spawn keeps its argv as it is today.
- An agy that does not know `--settings` exits non-zero on the unknown flag, and the unit reports that error: the failure is closed.
- The marked RESEARCH-MODE HOOK comment at line 325 becomes the pin's comment.

## Docs

- `units/gemini/adapter.mjs` header, READ-ONLY POSTURE: research runs in agy's Default mode **because the unit pins it**, since agy 1.5.7 made Auto the default; the limitation that the allow list rests on the operator's `settings.json` stays.
- `docs/SECURITY.md`: line 173 (the gemini row), 233 ("nothing in this package can pin its permissions from the outside" — one thing now can: the session's agent mode), 240 and 244 ("passes **no** `--mode` at all: agy runs in its standard mode"). Each says the mode is pinned per spawn and names the agy version that made it necessary.
- `CHANGELOG.md` 1.10.2, dated: what was open, since which agy version, what closes it, and the `/config` line for anyone on an older package.
- `docs/MEASUREMENTS.md`: the vendor CLI row for 1.10.2 at the live gate.

## Tests

One test file, through the tools' public entry with a recording spawn (the shape `test/gemini-catalog-1.6.2.test.mjs:63` already has):

- a `gemini_research` spawn's argv holds `--settings` followed by JSON whose `agentMode` is `""`;
- every `gemini_deep_research` stage spawn holds the same;
- a `gemini_image` spawn holds `--mode accept-edits` and no `--settings`.

Nothing pins doc text.

## Release

- Version 1.10.2 in `package.json` and the plugin manifest.
- Coder: `omelette-coder-medium` — the spec prints the flag, the constant and the tests. Tester, second pass included.
- Reviews: Grok, an Opus whole-branch review, and Mistral `mistral_security_review` in Codex's place — Codex is on the free tier until 2026-12-03 and has refused `gpt-6.1-sol` on the last two releases.
- Push the branch and see CI green before the merge.
- **Live gate, through the unit** (`omelette-fleet call gemini gemini_research …`):
  1. the `touch marker.txt` prompt with a scratch `cwd`: an error naming the denied `command`, no file;
  2. a plain web question on the configured default: an answer with a fetched source — `read_url` still runs under the pinned mode;
  3. `gemini_image` once: a file path comes back.

## Not in 1.10.2

- Pinning `permissions.allow` / `deny` through `--settings`. It would close the documented limitation that the posture rests on the operator's file; it is a design of its own (which rules, what the opt-in read set becomes). Backlog.
- agy's `--sandbox` flag and `--mode plan`: not re-evaluated here.
- A `doctor` line for the agy version.

## Open

- **The first agy version that accepts `--settings`.** `agy changelog` does not date it. The build finds it or the CHANGELOG says "not determined".
- **`--mode accept-edits` under 1.5.8**: the build runs the `touch` prompt once with it and records whether `command` is still denied. If it runs, that is a finding for the operator, not a change in this release.
- **Since when the operator's machine has 1.5.7**: `~/.gemini/antigravity-cli/updater` may say; recorded in the ledger if it does.
