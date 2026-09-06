---
{{marker}}
name: omelette-test
description: "Clean-context tester handoff — forks omelette-tester with the approved spec and the diff taken from git at invocation, so the tester never receives the coder's summary. Usage: /omelette-test <spec path>"
context: fork
agent: omelette-tester
disable-model-invocation: true
argument-hint: [spec path]
---
Spec to test against: read `$ARGUMENTS` first; it is the authority.

Diff of the working tree, taken from git at invocation (uncommitted work included):
!`git diff HEAD`

Untracked files (read them by path if they are part of the change):
!`git ls-files --others --exclude-standard`

Now follow your procedure: list the behaviours the spec promises, check coverage, write additional tests in a NEW file, run them through the real runner, quote the raw output, and rule each failure test-vs-spec. Never edit the implementation or the implementer's tests.
