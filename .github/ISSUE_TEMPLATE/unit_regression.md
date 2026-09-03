---
name: Unit regression
about: A unit stopped working after a vendor CLI updated itself — agy, grok or codex
title: ''
labels: unit-regression
assignees: ''
---

<!--
The vendor CLIs update themselves, so a unit that worked yesterday and fails
today has usually been changed underneath: new flags, a new output shape, a
retired model id. That is diagnosable only with the version and the exact
stderr — a paraphrase is not enough.

Nothing sensitive, please: no tokens, no API keys, no repository contents, no
prompts containing private code. Redact before pasting.
-->

## Unit

<!-- gemini (agy) / grok / codex -->

## Vendor CLI version

<!-- `agy --version`, `grok --version` or `codex --version`, verbatim -->

```console
$
```

## The tool call

<!-- The exact tool and arguments — via Claude Code, or reproduced with:
     ./bin/omelette-fleet.mjs call <unit> <tool> '{"...":"..."}' -->

```console
$ omelette-fleet call
```

## The exact error

<!-- Verbatim stderr / the error text the tool returned. Not a summary. -->

```
```

## `omelette-fleet doctor`

<!-- Redact home paths and usernames — replace your home directory with `~` — before pasting.
     If you cannot redact it safely, paste only the block for the failing unit. -->

```console
$ omelette-fleet doctor
```

## When it last worked

<!-- Approximate date, and the previous CLI version if you know it. -->
