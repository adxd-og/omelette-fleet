#!/usr/bin/env node
/**
 * omelette-fleet :: scripts/agent-usage.mjs
 * What the sub-agents of one Claude Code session cost, read out of that
 * session's transcript — the numbers docs/MEASUREMENTS.md is built from.
 *
 *   node scripts/agent-usage.mjs <transcript.jsonl> [--json]
 *
 * WHERE THE NUMBERS COME FROM. When a background sub-agent finishes, Claude
 * Code puts a task notification into the conversation:
 *   <task-id>…</task-id> … <summary>Agent "<description>" finished</summary> …
 *   <usage><subagent_tokens>N</subagent_tokens><tool_uses>N</tool_uses><duration_ms>N</duration_ms></usage>
 * This script collects those and nothing else. It does not read prompts,
 * answers or file contents, and it prints no path: a description that carries
 * an absolute path is cut down to the path's last segment.
 *
 * WHAT `subagent_tokens` IS. The harness's own count for the sub-agent at the
 * moment it stopped. An agent that is resumed reports again with a larger
 * number, so per agent the LARGEST report is kept — read it as the size of the
 * context the agent ended with: a floor on what it had to read, not a bill.
 *
 * Not part of the published package (`files` in package.json leaves scripts/
 * out): it is a measuring tool for whoever wants to repeat the measurement.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ONE NOTIFICATION AT A TIME: nothing is paired across a closing tag, or the id
// of a background command's notification (which has no usage block) gets
// paired with the agent that finished after it, and that agent is counted
// twice. The rule is the one the old single pattern encoded — an id, the first
// finished-agent summary after it, the first usage block after that, with no
// `</task-notification>` starting in either gap between them — and a closing
// tag INSIDE a summary's quoted description is text, not a gap, so the
// transcript is never cut at that literal. Each pattern runs once over the
// text, left to right; each id is then resolved by binary searches over what
// they found: no backtracking, O(n log n) at worst. The regex this replaced
// found the same pairs and was cubic on a transcript full of ids and summaries
// with no usage behind them (45 KB: 7 s).
const CLOSE = '</task-notification>';
const TASK_ID = /<task-id>([^<]+)<\/task-id>/g;
const SUMMARY = /<summary>Agent "([^"]*)" (?:finished|completed)<\/summary>/g;
const USAGE = /<subagent_tokens>(\d+)<\/subagent_tokens><tool_uses>(\d+)<\/tool_uses><duration_ms>(\d+)<\/duration_ms>/g;

/** Every match of a `g` pattern, in order, as { at, end, groups }: one pass, never looking back. */
function spans(re, text) {
  const out = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ at: m.index, end: re.lastIndex, groups: m.slice(1) });
  return out;
}

/** The index of the first span that starts at or after `pos` — the list's length when none does. */
function firstFrom(list, pos) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].at < pos) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Every finished-agent notification in `plain`, in order, as [id, description, tokens, toolUses, ms]. */
function readNotices(plain) {
  const text = String(plain);
  const ids = spans(TASK_ID, text);
  const summaries = spans(SUMMARY, text);
  const usages = spans(USAGE, text);
  const closes = [];
  for (let at = text.indexOf(CLOSE); at !== -1; at = text.indexOf(CLOSE, at + 1)) closes.push({ at });
  const nextClose = (pos) => { const i = firstFrom(closes, pos); return i < closes.length ? closes[i].at : Infinity; };
  // A summary pairs with the first usage after it — unless a closing tag starts between them.
  const withUsage = (s) => {
    const i = firstFrom(usages, s.end);
    return i < usages.length && usages[i].at < nextClose(s.end) ? { summary: s, usage: usages[i] } : null;
  };
  // The pair an id ending at `end` opens, or null. Only a summary that STARTS
  // before the first closing tag after the id is in reach, and the first of them
  // decides — unless it ended before that tag with no usage in front of it: then
  // the one summary still in reach is the one whose quoted text holds the tag.
  const pairFrom = (end) => {
    const close = nextClose(end);
    const i = firstFrom(summaries, end);
    if (i === summaries.length || summaries[i].at >= close) return null;
    const pair = withUsage(summaries[i]);
    if (pair || summaries[i].end > close) return pair;
    const j = firstFrom(summaries, close) - 1;
    return j > i && summaries[j].end > close ? withUsage(summaries[j]) : null;
  };
  const found = [];
  let from = 0; // the next match starts after the last one, as matchAll's did
  for (const id of ids) {
    if (id.at < from) continue;
    const pair = pairFrom(id.end);
    if (!pair) continue;
    found.push([id.groups[0], pair.summary.groups[0], ...pair.usage.groups]);
    from = pair.usage.end;
  }
  return found;
}

// A path SEGMENT may hold a space ("Jane Doe", "Acme Secret Project") but never
// starts or ends with one, so a path ends where no separator follows — and the
// last segment keeps the words after it. A space inside a path cannot be told
// from one after it, so two paths in one description can lose the words between
// them: a label shorter than it could be, never a directory name in a report.
const SEGMENT = String.raw`[^\s\\/"'](?:[^\\/"'\r\n]*[^\s\\/"'])?`;
const ABSOLUTE_PATH = new RegExp(String.raw`(?:[A-Za-z]:)?(?:[\\/]${SEGMENT}){2,}`, 'g');

/** A description is a label, not a place: absolute paths lose everything but their last segment. */
export function sanitise(description) {
  return String(description).replace(ABSOLUTE_PATH, (p) => p.split(/[\\/]/).pop()).trim();
}

/** The role a description names, by the words this project's orchestrator uses in its briefs. */
export function roleOf(description) {
  const d = description.toLowerCase();
  if (/^plan\b|planner/.test(d)) return 'planner';
  if (/omelette-test|\btester\b|test-verifier/.test(d)) return 'tester';
  if (/\breview\b|reviewer/.test(d) && !/fix round/.test(d)) return 'reviewer';
  if (/implement|fix round|mini round|\bcoder\b/.test(d)) return 'coder';
  if (/\bdocs?\b|diagram|changelog/.test(d)) return 'docs';
  return 'other';
}

/**
 * Every sub-agent the transcript saw finish, one row per agent.
 * @param {string} text the raw JSONL (notifications sit inside JSON strings, so
 *   their quotes and newlines arrive escaped — unescaped here, once)
 * @returns {Array<{id:string, description:string, role:string, tokens:number, toolUses:number, seconds:number, reports:number}>}
 */
export function parseUsage(text) {
  const plain = String(text).replace(/\\"/g, '"').replace(/\\n/g, '\n');
  const byId = new Map();
  for (const [id, description, tokens, toolUses, ms] of readNotices(plain)) {
    const seen = byId.get(id);
    const report = { tokens: Number(tokens), toolUses: Number(toolUses), seconds: Math.round(Number(ms) / 1000) };
    const key = `${report.tokens}/${report.toolUses}/${report.seconds}`;
    if (!seen) {
      const label = sanitise(description);
      byId.set(id, { id, description: label, role: roleOf(label), ...report, reports: 1, keys: new Set([key]) });
    } else if (!seen.keys.has(key)) { // the same notification is quoted back more than once; a resume is a new one
      seen.keys.add(key);
      seen.reports += 1;
      seen.toolUses += report.toolUses;
      seen.seconds += report.seconds;
      seen.tokens = Math.max(seen.tokens, report.tokens);
    }
  }
  return [...byId.values()].map(({ keys, ...row }) => row);
}

/** Totals per role, largest first. */
export function byRole(rows) {
  const roles = new Map();
  for (const r of rows) {
    const t = roles.get(r.role) || { role: r.role, agents: 0, tokens: 0, toolUses: 0, seconds: 0 };
    t.agents += 1; t.tokens += r.tokens; t.toolUses += r.toolUses; t.seconds += r.seconds;
    roles.set(r.role, t);
  }
  return [...roles.values()].sort((a, b) => b.tokens - a.tokens);
}

const n = (x) => x.toLocaleString('en-US').replace(/,/g, ' ');

/** Two markdown tables: per role, then per agent in the order they finished. */
export function renderMarkdown(rows) {
  const out = ['| Role | Agents | Tokens | Tool uses | Minutes |', '|---|---:|---:|---:|---:|'];
  for (const t of byRole(rows)) out.push(`| ${t.role} | ${t.agents} | ${n(t.tokens)} | ${n(t.toolUses)} | ${n(Math.round(t.seconds / 60))} |`);
  out.push('', '| Agent | Role | Tokens | Tool uses | Minutes | Reports |', '|---|---|---:|---:|---:|---:|');
  for (const r of rows) out.push(`| ${r.description.replace(/\|/g, '\\|')} | ${r.role} | ${n(r.tokens)} | ${n(r.toolUses)} | ${n(Math.round(r.seconds / 60))} | ${r.reports} |`);
  return out.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: node scripts/agent-usage.mjs <transcript.jsonl> [--json]'); process.exit(2); }
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { console.error(`agent-usage: cannot read ${file}: ${e.code || e.message}`); process.exit(2); }
  const rows = parseUsage(text);
  console.log(args.includes('--json') ? JSON.stringify(rows, null, 2) : renderMarkdown(rows));
}
