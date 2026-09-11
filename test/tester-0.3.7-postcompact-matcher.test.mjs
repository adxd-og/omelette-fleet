/**
 * omelette-fleet :: test/tester-0.3.7-postcompact-matcher.test.mjs
 *
 * Coverage gap for 0.3.7 M4, against
 * docs/superpowers/specs/2026-09-10-0.3.7-design.md:
 *
 *   "`HOOK_EVENTS` gains `PostCompact` (no matcher)"
 *
 * test/rules.test.mjs's own
 * 'the snippet wires all six events: SessionStart on `compact`, and the four
 * unmatched ones on nothing' asserts there are FOUR unmatched events in its
 * title and prose, but its loop only checks three:
 *
 *   for (const event of ['PreCompact', 'PostToolUse', 'Stop']) {
 *     assert.equal('matcher' in parsed.hooks[event][0], false, ...);
 *   }
 *
 * `PostCompact` — the fourth unmatched event the title promises — is never
 * checked for the absence of a `matcher` key anywhere in the suite: every
 * other PostCompact-related assertion (rules.test.mjs's HOOK_EVENTS order and
 * key-set checks, cli.test.mjs's doctor "wired: ... PostCompact" wiring
 * checks) is satisfied whether or not PostCompact carries a matcher, because
 * none of them inspects that key. A regression that pinned PostCompact to a
 * matcher (breaking "no matcher" silently, since every PostCompact event
 * would then simply stop firing when the guard's own PostCompact hook body
 * never sets one) would pass the whole existing suite.
 *
 * Never edits core/rules.mjs or test/rules.test.mjs — only this new file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hookSettingsSnippet, HOOK_EVENTS } from '../core/rules.mjs';

test('hookSettingsSnippet: PostCompact carries no matcher, on every platform the snippet renders for', () => {
  assert.ok(HOOK_EVENTS.includes('PostCompact'), 'sanity: PostCompact is one of the six events');
  for (const platform of ['darwin', 'win32']) {
    const parsed = JSON.parse(hookSettingsSnippet('/Users/me/app/.claude/hooks/omelette-guard.mjs', platform).join('\n'));
    assert.equal(
      'matcher' in parsed.hooks.PostCompact[0],
      false,
      `PostCompact must have no matcher on ${platform} — a compaction summary is written whichever trigger fired`,
    );
    // Same shape as the other three unmatched events (PreCompact, PostToolUse,
    // Stop): one group, one hook, type "command", nothing else.
    assert.deepEqual(Object.keys(parsed.hooks.PostCompact[0]).sort(), ['hooks']);
    assert.equal(parsed.hooks.PostCompact[0].hooks.length, 1);
    assert.equal(parsed.hooks.PostCompact[0].hooks[0].type, 'command');
  }
});

test('hookSettingsSnippet: EVERY unmatched event the spec promises (PreCompact, PostToolUse, Stop, PostCompact) is actually matcher-less — not just three of the four', () => {
  const parsed = JSON.parse(hookSettingsSnippet('/Users/me/app/.claude/hooks/omelette-guard.mjs', 'darwin').join('\n'));
  const unmatched = ['PreCompact', 'PostToolUse', 'Stop', 'PostCompact'];
  assert.equal(unmatched.length, HOOK_EVENTS.length - 2, 'PreToolUse and SessionStart are the only matched two');
  for (const event of unmatched) {
    assert.equal('matcher' in parsed.hooks[event][0], false, `${event} should carry no matcher`);
  }
});
