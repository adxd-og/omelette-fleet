# Security policy

This package drives vendor CLIs that read your files and your web. The whole design rests on a single claim — **units read, the manager writes** — so a report that breaks that claim is worth more to us than any feature.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| < 0.1 | No |

There is one release line. Fixes land on `main` and go out in the next 0.1.x.

## Reporting a vulnerability

Use **GitHub private vulnerability reporting** on [adxd-og/omelette-fleet](https://github.com/adxd-og/omelette-fleet/security/advisories/new) — Security → Report a vulnerability. It keeps the report private until there is a fix.

If private reporting is unavailable to you, open a regular issue with `security` in the title and **no details** — just say you have a report and wait to be contacted. Do not paste the reproduction into a public issue.

There is no email channel.

Please include, as far as you have it: the version, the unit and vendor CLI version, the config and environment that made it reachable, and the smallest reproduction you can manage. Redact paths, usernames and anything from a real repository.

## What counts

These are the reports we want, in rough order of severity:

- **A path for a unit to write outside its sandbox or tool allowlist.** Any way a read-only unit touches the filesystem, the network or a process beyond what its vendor CLI is confined to — including a `codex_code_review` write that escapes the `cwd` it was granted.
- **A config-only widening of a unit's mode.** The write ceiling takes two independent keys: `mode` in `fleet.config.json` *and* the unit named in `OMELETTE_ALLOW_WRITE` in the MCP server's environment. Anything that gets a unit past `read-only` with only the config file — or with only a tool argument — defeats the ceiling and is a vulnerability.
- **A secret reaching a vendor CLI's environment.** The child environment is built from an allowlist, then billing-risk API keys are scrubbed on top. A name that slips through the allowlist, a passthrough pattern that re-admits a scrubbed key, or any other way `GH_TOKEN`, cloud credentials or an `*_API_KEY` reach a model's process.
- **A prompt-injection path that executes rather than reports.** Content a unit ingests — a web page, a file in a repository — is untrusted by design, and a unit returning attacker-controlled *text* is expected. A path where that content instead causes a spawn, a file write, a shell interpretation, or an argument the adapter did not construct is a vulnerability.

Also in scope: argv or path handling that turns data into shell syntax, a status-feed write that escapes `$OMELETTE_HOME` or lands with wrong permissions, and anything that makes `doctor` report a broken unit as healthy.

**Not in scope:** a vulnerability in a vendor CLI itself or in the model behind it — report those to the vendor; the quality, accuracy or hallucinations of a unit's answers (see the per-unit "do not trust it with" column in the README); and anything that requires you to have already deliberately opened the write ceiling on your own machine.

## What to expect

This is a small project maintained by one person, so keep expectations modest: an acknowledgement within about a week, and an honest answer about whether and when it will be fixed. Reports that break the read-only claim are prioritised over everything else. You will be credited in the advisory and the changelog unless you prefer otherwise, and we will not ask you to stay quiet indefinitely — if a fix is not coming, we will say so and you should publish.

## Threat model

What each mechanism actually enforces, how strong it is per vendor, and where the guarantees stop: **[docs/SECURITY.md](docs/SECURITY.md)**.
