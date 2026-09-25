/**
 * omelette-fleet :: core/partial.mjs
 * THE ONE RULE FOR `partial` (1.6.0): an answer carries `partial: true` if and
 * only if its text carries one of the markers below. The adapters never spell a
 * marker; they call `withPartial`, which appends the marker AND sets the flag,
 * so the two cannot drift apart. The image tools are the standing exception
 * (a bare path by contract, the flag alone) and do not come through here.
 *
 * Every string is byte-identical to the 1.5.0 adapters' own; tests pin them.
 */

/** kind → (detail) => text after `[<unit>: ` and before `]`. */
const KINDS = {
  capped: ({ outputCap }) => `output capped at ${outputCap} chars — the beginning of the stream was dropped; treat the answer as partial`,
  killed: ({ unit, after }) => `hard-killed after ${after}s — treat the answer as partial; raise ${unit}.timeoutS in the fleet config`,
  // grok appends what the CLI had reported instead of the standard tail (adapter.mjs `cancelTail`).
  cancelled: ({ tail } = {}) => `cancelled by the client${tail || ' — treat the answer as partial'}`,
  exited: ({ code }) => `CLI exited ${code} — treat the answer as partial`,
  early: ({ stopReason }) => `run ended early — stopReason=${stopReason}`,
  status: ({ status }) => `run ended early — status=${status}`,   // gemini: agy reported a non-SUCCESS status
  unfinished: () => 'run ended before turn.completed — treat as partial',
  stages: ({ n, m }) => `${n} of ${m} stages returned partial answers`,
  gathers: ({ n, m, subs }) => `${n} of ${m} gathers failed: ${subs}`,
};
export const MARK_KINDS = Object.freeze(Object.keys(KINDS));

/** `[<unit>: <text>]` — the marker as it appears in an answer. */
export function partialMark(unit, kind, detail = {}) {
  const make = KINDS[kind];
  if (!make) throw new Error(`partialMark: unknown kind "${kind}"`);
  return `[${unit}: ${make({ unit, ...detail })}]`;
}

/**
 * Matches every marker above for the three units, and nothing else the
 * adapters print (`_(gather failed: …)_`, the degraded banner and the
 * cancellation notes are prose, not markers; the flag on a cancelled deep
 * research report comes from the `cancelled` marker appended after its note).
 * `after` may be `?` (codex with no timeoutS) and `code` may be `null` (a
 * vendor child that died by an outside signal). A hard-kill marker names the
 * config key of the unit its prefix names (`\1`).
 */
export const PARTIAL_MARK_RE = new RegExp(
  '\\[(gemini|grok|codex): (' +
  'output capped at \\d+ chars — the beginning of the stream was dropped; treat the answer as partial' +
  '|hard-killed after [\\d.?]+s — treat the answer as partial; raise \\1\\.timeoutS in the fleet config' +
  '|cancelled by the client( — [^\\]]*)?' +
  '|CLI exited (-?\\d+|null) — treat the answer as partial' +
  '|run ended early — stopReason=[^\\]]*' +
  '|run ended early — status=[^\\]]*' +
  '|run ended before turn\\.completed — treat as partial' +
  '|\\d+ of \\d+ stages returned partial answers' +
  '|\\d+ of \\d+ gathers failed: [^\\]]*' +
  ')\\]',
);

/**
 * Append `marker` to the result's text and set the flag. `result` may be a
 * string (grok's bare-string shape) or `{ text, ... }`; the shape is kept.
 * An empty text is NOT marked: a marker on nothing is not an answer (the
 * adapters throw for those cases before reaching here).
 */
export function withPartial(result, marker) {
  if (typeof result === 'string') return result ? { text: `${result}\n\n${marker}`, partial: true } : result;
  const text = String((result && result.text) ?? '');
  if (!text) return result;
  return { ...result, text: `${text}\n\n${marker}`, partial: true };
}
