# Changelog

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
- **`omelette-fleet` CLI**: `install`, `uninstall`, `doctor [--probe-models]`, `show`, `set`, `call` — never shells out, and writes nothing but the fleet config.
- Zero runtime dependencies; Node ≥ 20; `node --test` invariant specs under `test/`.
