# Contributing

Thanks for looking. This is a small package with a narrow promise, and most of the rules below exist to keep that promise cheap to verify.

## Running the tests

```bash
git clone https://github.com/adxd-og/omelette-fleet.git
cd omelette-fleet
npm test
```

No `npm install` — there is nothing to install. `npm test` is `node --test` over `test/*.test.mjs` and needs Node ≥ 20, no vendor CLI, and no `claude`. CI runs exactly that on Node 20 and 22, on Ubuntu and macOS.

To exercise a real unit by hand, use the CLI rather than a client: `./bin/omelette-fleet.mjs call codex codex_models '{}'`.

## The rules

- **Zero runtime dependencies.** Node's standard library only, in `bin/`, `core/`, `units/` and `servers/`. This is not a preference — it is the reason the package has no build step, no lockfile churn and no supply chain. A PR that adds a dependency needs to argue why the alternative is worse.
- **Plain ESM, no build step.** The files that ship are the files that run. No transpiler, no bundler, no generated code.
- **Header comments explain WHY.** Every non-obvious block in this codebase says what it is defending against, not what it does — the code already says what it does. If a reviewer has to ask "why is this here", the comment is missing.
- **Every behaviour change ships a test that runs without any vendor CLI.** Use the fake-binary pattern: point the unit's binary at `process.execPath` and let a throwaway script play the CLI, so the test can assert on the exact argv the adapter built and on what did *not* reach the child environment. That is how the read-only posture stays tested rather than asserted. The pattern, with a working example: [docs/ADAPTERS.md](docs/ADAPTERS.md#4-testunittestmjs--the-fake-binary-pattern).
- **The adapter's job is the vendor, the runtime's job is everything else.** An adapter that touches `process.stdout`, reads the config itself, or calls `child_process` directly is doing the runtime's work. The split is tabulated at the top of [docs/ADAPTERS.md](docs/ADAPTERS.md).
- **Never widen a unit by default.** New config keys narrow; the write ceiling stays two independent keys. If a change could let a unit do more than read, say so explicitly in the PR.

## Adding a unit

Three files and a test — `units/<unit>/models.js`, `units/<unit>/adapter.mjs`, `servers/<unit>.mjs`. The runtime already gives you config resolution, the write ceiling, catalog validation, the mutate gate, the status feed, bounded spawn with the env allowlist and billing scrub, and JSON-RPC. Step by step, with a skeleton: **[docs/ADAPTERS.md](docs/ADAPTERS.md)**.

## What a PR should contain

- One change, described in terms of the behaviour that differs before and after.
- The test that fails without it.
- Doc updates in the same PR when the change is user-visible — `README.md`, `docs/CONFIG.md` for a config key, `docs/SECURITY.md` for anything touching the ceiling, the env allowlist or a sandbox flag.
- A `CHANGELOG.md` entry for anything a user would notice.
- No new dependencies, and no new files outside the shape above.

## Reporting a vendor-CLI regression

The vendor CLIs update themselves, so "it worked yesterday" usually means one of them changed its flags, its output shape or its model ids. Those reports are useful, but only with evidence:

- the CLI version — `agy --version`, `grok --version`, `codex --version`;
- the exact tool call, arguments included;
- the **exact stderr**, verbatim, not a paraphrase;
- `omelette-fleet doctor` output, with paths and usernames redacted.

Use the **Unit regression** issue template, which asks for exactly that. Do not paste repository contents, tokens or anything else sensitive.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
