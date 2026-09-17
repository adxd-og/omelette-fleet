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

// ONE NOTIFICATION AT A TIME: the gaps may not cross a closing tag, or the id of
// a background command's notification (which has no usage block) gets paired
// with the agent that finished after it, and that agent is counted twice.
const GAP = String.raw`(?:(?!<\/task-notification>)[\s\S])*?`;
const NOTICE = new RegExp(String.raw`<task-id>([^<]+)<\/task-id>${GAP}<summary>Agent "([^"]*)" (?:finished|completed)<\/summary>${GAP}<subagent_tokens>(\d+)<\/subagent_tokens><tool_uses>(\d+)<\/tool_uses><duration_ms>(\d+)<\/duration_ms>`, 'g');

/** A description is a label, not a place: absolute paths lose everything but their last segment. */
export function sanitise(description) {
  return String(description).replace(/(?:[A-Za-z]:)?(?:[\\/][^\s\\/"']+){2,}/g, (p) => p.split(/[\\/]/).pop()).trim();
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
  for (const m of plain.matchAll(NOTICE)) {
    const [, id, description, tokens, toolUses, ms] = m;
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
