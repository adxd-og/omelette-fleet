# Changelog

## 0.2.0 — 2026-09-03

- **`codex_image`** — image generation on the codex unit via the Codex CLI's built-in **gpt-image-2** tool (verified live on codex-cli 0.153.0, ChatGPT plan: present headless under `--ignore-user-config --ignore-rules`, behind no feature flag). Returns the absolute path of the saved PNG, reports real token usage, and is never retried — a re-issued generation bills image quota twice. The run is spawned `-s workspace-write -C <a fresh directory under the OS temp dir>` **without consulting the fleet ceiling**: the kernel scopes every write to that one throwaway directory, outside every project, because the built-in tool saves under `~/.codex/generated_images/` and then copies the file into the working directory with a shell command. Same posture as `gemini_image`'s temp cwd; the rationale is in [docs/SECURITY.md](docs/SECURITY.md). Web search is off for image runs and no reasoning effort is passed.
- **`gemini_image` prompt hardening** — the prompt now states that only the built-in image tool may be used and that terminal commands are unavailable, mirroring the research preamble. The first live image call was lost to the model reaching for the shell `command` tool, which headless agy auto-denies; it only succeeded on the retry.
- **Update mechanism** — `omelette-fleet update` reports the latest release and fast-forwards a git checkout (`git pull --ff-only`); a dirty tree or a diverged branch is refused with the reason and nothing is written, an npm install gets the exact `npm i -g` line, and MCP registrations are never rewritten (they hold absolute paths a pull does not move). `update --check` fetches, pulls nothing, and exits **3** when an update is available so a script can branch on it. Each unit server also prints one stderr line at startup when a newer release exists: fire-and-forget, capped at 2.5 s, cached for 24 h in `<home>/update-check.json`, and silent when you are current. Opt out with `OMELETTE_UPDATE_CHECK=0` or the new top-level `"updateCheck": false` config key. The only outbound request this package makes is that one unauthenticated GitHub releases call — no telemetry, nothing downloaded, nothing executed (see [docs/SECURITY.md](docs/SECURITY.md#network)).
- **`doctor`** gained a `version <current> · latest <latest>` header line, and `--help` covers the new command.
- **`gemini_image` is no longer retried.** With the prompt fixed, a second attempt only spends image quota twice — the same rule the fleet's other image tools already followed.
- **`serverInfo.version`** now comes from `package.json` instead of a constant frozen into `core/unit.mjs`, so `initialize` stops reporting a stale release number.
- **`core/artifact.mjs`** — `extractImagePath()` lifted out of the grok adapter and shared with codex: an image tool returns a path that exists on disk, never one the model asserted.

## 0.1.0 — 2026-09-03

Initial release.

- **Three units**, each a standalone stdio MCP server spawning a vendor CLI headless on the subscription you already pay for:
  - **gemini** (`agy`) — `gemini_research`, `gemini_deep_research`, `gemini_image`, `gemini_models`.
  - **grok** (`grok`) — `grok_research`, `grok_code_review`, `grok_image`, `grok_image_edit`, `grok_models`.
  - **codex** (`codex`) — `codex_research`, `codex_code_review`, `codex_models`.
- **Write ceiling** — `workspace-write` takes two keys: the unit's `mode` in the config file *and* the unit named in `OMELETTE_ALLOW_WRITE` in the server environment (`ORION_ALLOW_GEMINI_MUTATE=1` honoured as a legacy alias for `gemini`). The config can only narrow, and a unit that does not implement a mode refuses it even with the ceiling open.
- **Environment allowlist** — a vendor CLI's environment is built from a fixed allowlist plus the unit's `envPassthrough` patterns plus `OMELETTE_ENV_PASSTHROUGH`, then the billing scrub, then the adapter's own additions. Nothing is inherited: a model running read-only shell commands cannot read tokens or cloud credentials out of the server's shell.
- **Codex config isolation** — every run passes `--ignore-user-config --ignore-rules`, so `~/.codex/config.toml` (MCP servers, plugins, hooks, notify) never reaches a fleet call; the OS sandbox bounds the filesystem, not a configured MCP tool. With no model configured the adapter pins the catalog head explicitly.
- **Read-only by default**, enforced per vendor: Codex's OS-level sandbox, Grok's six-layer spawn-arg toolset allowlist (write mode declared unsupported), agy's permission policy plus `--disable-slash-commands`.
- **Fleet config** at `$OMELETTE_HOME/fleet.config.json` (default `~/.omelette`): built-in → `defaults` → `units.<unit>` → environment, re-read per call, malformed files degrade to a warning.
- **Status feed** (schema 1): per-unit snapshot plus a shared NDJSON log, atomic, 0600, self-trimming, fail-soft.
- **Bounded spawn**: own process group with a wall-clock SIGKILL, output caps, actionable missing-binary errors; a 16 MiB cap on one JSON-RPC frame keeps a broken client from taking the server down.
- **Honest results**: a run that produced text but exited badly is returned with a visible partial marker, and adapter refusals come back as MCP errors rather than error-shaped successes.
- **Model catalogs** per unit — allowlists validated before any spawn, ids and effort levels verified live, with routing guidance served by each `<unit>_models` tool.
- **`omelette-fleet` CLI**: `install`, `uninstall`, `doctor [--probe-models]`, `show`, `set`, `call`, each answering its own `--help`. Never shells out, and writes nothing but the fleet config. `doctor` reads Claude Code's config from `CLAUDE_CONFIG_DIR` before `~/` and says which, counts a registration as yours only when it points at this clone's server file, and reports an unreadable probe as `unknown` rather than guessing; `uninstall` tells a no-op apart from a failed removal; `call` rejects non-object arguments and treats a protocol-level error as a failure instead of an empty success.
- Zero runtime dependencies; Node ≥ 20; `node --test` invariant specs under `test/`.
