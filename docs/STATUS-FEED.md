# Status feed

What each unit is doing right now, on disk, in a format anything can read — a menu-bar app, a HUD, or `tail -f`. Two files per fleet home (`$OMELETTE_HOME`, default `~/.omelette`).

Readers are built against a versioned contract: **schema 1**. A change bumps the number; fields are never silently reshaped.

## `status-<unit>.json` — per-unit snapshot

One file per unit, rewritten on every event.

```json
{
  "schema": 1,
  "unit": "codex",
  "active": [
    {
      "id": "48123-2",
      "tool": "codex_code_review",
      "model": "gpt-5.6-terra",
      "effort": "high",
      "promptPreview": "review the spawn layer for unbounded output",
      "startedAt": "2026-09-03T09:14:02.118Z"
    }
  ],
  "lastEvent": {
    "tool": "codex_research",
    "status": "ok",
    "endedAt": "2026-09-03T09:13:44.902Z",
    "durationMs": 21883,
    "error": null,
    "usage": { "input": 60835, "cachedInput": 45312, "output": 236, "reasoning": 103 }
  },
  "updatedAt": "2026-09-03T09:14:02.119Z"
}
```

| Field | Meaning |
|---|---|
| `schema` | Always `1` for this contract |
| `unit` | The unit name (`gemini`, `grok`, `codex`, …) |
| `active[]` | Tool calls running **in this process** right now. Parallel calls are possible, so this is an array; a multi-spawn pipeline like `gemini_deep_research` is **one** entry for the whole run, not one per spawn |
| `active[].id` | `<pid>-<seq>` — unique within the process, and the join key to the log |
| `active[].tool` | Tool name |
| `active[].model` / `.effort` | The resolved values for this call, or `null` when the vendor default applies |
| `active[].promptPreview` | The call's `prompt` (or `question`), control characters collapsed to spaces, trimmed, first **200** characters |
| `active[].startedAt` | ISO-8601 UTC |
| `lastEvent` | The last finished call, or `null` before the first one |
| `lastEvent.tool` | Tool name |
| `lastEvent.status` | `"ok"` or `"error"` |
| `lastEvent.endedAt` | ISO-8601 UTC |
| `lastEvent.durationMs` | Wall-clock milliseconds |
| `lastEvent.error` | Error text, truncated to **500** characters, or `null` |
| `lastEvent.usage` | Present only when the unit reports token usage — Codex: `{input, cachedInput, output, reasoning}`; Gemini: `{input, output}`; Grok: absent |
| `updatedAt` | When this snapshot was written |

Only tools that **spawn a CLI** are tracked. `<unit>_models` and any other local catalog read never appear.

`status: "error"` covers everything that did not return a clean answer: a failed run, a rejected model or effort, a prompt the mutate gate refused, and a refusal the adapter made itself (a missing `prompt`, a `cwd` that is not an absolute existing directory). A call rejected after the config check — an unknown model, a gated prompt — still produces a matching `start`/`end` pair even though nothing spawned. A disabled unit and an unknown tool name are refused earlier and never reach the feed.

## `fleet-log.ndjson` — shared append log

One compact JSON object per line, all units appending to the same file, one `O_APPEND` write per event.

```
{"schema":1,"ts":"2026-09-03T09:13:23.019Z","unit":"codex","event":"start","id":"48123-1","tool":"codex_research","model":"gpt-5.6-terra","promptPreview":"what is the current LTS of node"}
{"schema":1,"ts":"2026-09-03T09:13:44.902Z","unit":"codex","event":"end","id":"48123-1","tool":"codex_research","status":"ok","durationMs":21883,"usage":{"input":60835,"cachedInput":45312,"output":236,"reasoning":103}}
```

**`start`** carries `schema, ts, unit, event, id, tool, model, promptPreview`.
**`end`** carries `schema, ts, unit, event, id, tool, status, durationMs`, plus `error` when there was one, plus any extra the unit reported (`usage`).

`id` joins the pair. `effort` appears in the snapshot but not in the log line.

## Guarantees

- **Atomic snapshots.** Each write goes to `status-<unit>.json.<pid>.tmp` in the same directory and is `rename`d into place, so a reader never sees a half-written file. Both files are created with mode `0600`.
- **Fail-soft, absolutely.** Every write is synchronous and wrapped in try/catch. A full disk, a read-only home, a vanished directory — none of it can break, crash, or delay a tool call. There is no "status feed error" surfaced anywhere; the feed simply stops updating.
- **Crash recovery on boot.** At process start a unit re-reads the previous `lastEvent` and carries it over, clears any `active` entries left behind by a crashed predecessor, and trims the log. A stale `active` entry from a killed process therefore survives at most until that unit's server next starts.
- **Trimming.** At process start only: if `fleet-log.ndjson` is larger than ~500 KB, it is rewritten with the last ~1000 lines (same tmp + rename dance). The file never grows without bound, and it is never trimmed mid-session, so a `tail -f` is not disturbed while you watch it.

## Turning it off

Per unit, in `fleet.config.json`:

```json
{ "units": { "grok": { "status": false } } }
```

For the whole fleet, in the config `defaults` block, or with `OMELETTE_STATUS=0` in the server environment. The setting is read **per event**, so switching it off takes effect on the next call without a restart. A disabled feed writes nothing at all — no snapshot, no log line, and `start()` returns no token.

## Reading it

```bash
tail -f ~/.omelette/fleet-log.ndjson | jq -r '"\(.ts) \(.unit) \(.event) \(.tool) \(.status // .promptPreview[0:60])"'
jq -r '.active[] | "\(.unit // "?") \(.tool) since \(.startedAt)"' ~/.omelette/status-*.json   # what is running now
jq -r 'select(.event=="end" and .status=="error") | "\(.ts) \(.unit) \(.tool): \(.error)"' ~/.omelette/fleet-log.ndjson   # failures
jq -s 'map(select(.event=="end")) | group_by(.unit)[] | {unit: .[0].unit, calls: length, ms: (map(.durationMs) | add)}' ~/.omelette/fleet-log.ndjson
watch -n2 'jq -r ".unit + \": \" + (.active | length | tostring) + \" active\"" ~/.omelette/status-*.json'
```

A menu-bar app wants the snapshots: they are small, fixed-size, and answer "is anything running, and what happened last" in one read per unit. The log is for history and for anything that needs to notice events as they happen.
