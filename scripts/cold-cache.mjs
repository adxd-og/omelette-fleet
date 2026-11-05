#!/usr/bin/env node
/**
 * omelette-fleet :: scripts/cold-cache.mjs
 * Cold prompt-cache restarts in sub-agent transcripts — the count behind
 * "Cold cache restarts in sub-agent transcripts" in docs/MEASUREMENTS.md.
 *
 *   node scripts/cold-cache.mjs <project dir>... [--json]
 *
 * A <project dir> is one `~/.claude/projects/<slug>`; every
 * `<session>/subagents/agent-*.jsonl` under it is read, with the role from the
 * `.meta.json` beside it (`agentType`) where Claude Code wrote one.
 *
 * WHAT A COLD RESTART IS. One API request is one `message.id`. A request is
 * cold when it is not the agent's first, its context (input + cache writes +
 * cache reads) is at least 10 000 tokens, and less than a fifth of that was
 * read from the cache: the prefix had lapsed and was written again. Its CAUSE
 * is what the agent did last before it — a Bash call (with the call's wall
 * time, tool_use to tool_result), another tool, or a message from the
 * orchestrator (a user entry that is not a tool result: the brief that resumed
 * it). Its GAP is the time since the start of the agent's previous request,
 * the clock the API's TTL runs on (five minutes for a sub-agent unless the
 * operator chose an hour). A gap under five minutes is a compaction or a
 * prefix change, not the TTL.
 *
 * AGGREGATES ONLY. It prints counts, token sums and durations: no transcript
 * content, no path, no command text. Not part of the published package
 * (`files` in package.json leaves scripts/ out).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MIN_CONTEXT = 10_000;
const COLD_READ_SHARE = 0.2;
const LONG_BASH_MIN = 5;

/** The gap bucket a cold restart falls in, in minutes since the previous request. */
export function bucketOf(minutes) {
  if (!Number.isFinite(minutes)) return 'unknown';
  if (minutes < 5) return '<5';
  if (minutes < 10) return '5–10';
  if (minutes < 30) return '10–30';
  if (minutes < 60) return '30–60';
  return '>60';
}

/**
 * One transcript's entries (parsed JSONL, in file order) → its requests, its
 * cold restarts and its long Bash calls.
 */
export function analyseTranscript(entries, role = '') {
  const requests = []; // { ts, model, cc, cr, inp, prevTs, cause, causeMin }
  const seen = new Set();
  const toolUse = new Map(); // tool_use id → { name, ts }
  const longBash = [];
  let lastRequestTs = null;
  let cause = null;
  let causeMin = null;
  for (const e of entries) {
    const ts = Date.parse(e.timestamp);
    const m = e.message;
    if (e.type === 'assistant' && m && m.usage) {
      const id = m.id || e.requestId || e.uuid;
      if (!seen.has(id)) {
        seen.add(id);
        const u = m.usage;
        requests.push({ ts, model: m.model, cc: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0, inp: u.input_tokens || 0, prevTs: lastRequestTs, cause, causeMin });
        lastRequestTs = ts;
      }
      for (const c of m.content || []) if (c.type === 'tool_use') toolUse.set(c.id, { name: c.name, ts });
      continue;
    }
    if (e.type !== 'user' || !m) continue;
    if (Array.isArray(m.content)) {
      let sawResult = false;
      for (const c of m.content) {
        if (c.type !== 'tool_result') continue;
        sawResult = true;
        const t = toolUse.get(c.tool_use_id);
        if (!t) continue;
        const min = (ts - t.ts) / 60_000;
        cause = t.name;
        causeMin = min;
        if (t.name === 'Bash' && min >= LONG_BASH_MIN) longBash.push(+min.toFixed(1));
      }
      if (sawResult) continue;
    }
    cause = 'orchestrator';
    causeMin = null;
  }
  const cold = [];
  requests.forEach((r, i) => {
    if (i === 0) return;
    const total = r.cc + r.cr + r.inp;
    if (total < MIN_CONTEXT || r.cr > COLD_READ_SHARE * total) return;
    const gapMin = r.prevTs == null ? NaN : (r.ts - r.prevTs) / 60_000;
    cold.push({ tokens: r.cc, model: r.model, gapMin, bucket: bucketOf(gapMin), cause: r.cause || 'none', causeMin: r.causeMin });
  });
  return { role, requests: requests.length, writes: requests.reduce((s, r) => s + r.cc, 0), reads: requests.reduce((s, r) => s + r.cr, 0), cold, longBash };
}

/** Many transcripts' analyses → the totals the measurement reports. */
export function summarise(analyses) {
  const out = { agents: analyses.length, requests: 0, writes: 0, reads: 0, cold: 0, coldTokens: 0, byGap: {}, byCause: {}, byRole: {}, longBash: { count: 0, under8: 0, durations: [] } };
  for (const a of analyses) {
    out.requests += a.requests; out.writes += a.writes; out.reads += a.reads;
    const role = a.role || '?';
    const r = out.byRole[role] = out.byRole[role] || { agents: 0, requests: 0, cold: 0, coldTokens: 0 };
    r.agents++; r.requests += a.requests;
    for (const c of a.cold) {
      out.cold++; out.coldTokens += c.tokens; r.cold++; r.coldTokens += c.tokens;
      const g = out.byGap[c.bucket] = out.byGap[c.bucket] || { n: 0, tokens: 0 };
      g.n++; g.tokens += c.tokens;
      const k = `${c.bucket} | ${c.cause}`;
      const b = out.byCause[k] = out.byCause[k] || { n: 0, tokens: 0 };
      b.n++; b.tokens += c.tokens;
    }
    for (const d of a.longBash) { out.longBash.count++; if (d < 8) out.longBash.under8++; out.longBash.durations.push(d); }
  }
  const ds = out.longBash.durations.sort((x, y) => x - y);
  out.longBash.median = ds.length ? ds[Math.floor(ds.length / 2)] : null;
  out.longBash.p90 = ds.length ? ds[Math.floor(ds.length * 0.9)] : null;
  delete out.longBash.durations;
  return out;
}

function parseJsonl(path) {
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line: skipped */ }
  }
  return out;
}

function roleOf(transcriptPath) {
  const meta = transcriptPath.replace(/\.jsonl$/, '.meta.json');
  if (!existsSync(meta)) return '';
  try { return String(JSON.parse(readFileSync(meta, 'utf8')).agentType || ''); } catch { return ''; }
}

/** Every sub-agent transcript under the project dirs given. */
export function transcriptsUnder(projectDirs) {
  const files = [];
  for (const root of projectDirs) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    for (const s of readdirSync(root)) {
      const d = join(root, s, 'subagents');
      if (!existsSync(d) || !statSync(d).isDirectory()) continue;
      for (const f of readdirSync(d)) if (f.startsWith('agent-') && f.endsWith('.jsonl')) files.push(join(d, f));
    }
  }
  return files;
}

export function renderText(s) {
  const M = (n) => `${(n / 1e6).toFixed(1)} M`;
  const lines = [
    `agents ${s.agents} · requests ${s.requests} · cache writes ${M(s.writes)} · cache reads ${M(s.reads)}`,
    `cold restarts ${s.cold} (${s.requests ? ((100 * s.cold) / s.requests).toFixed(1) : 0}% of requests) · tokens rewritten ${M(s.coldTokens)} (${s.writes ? ((100 * s.coldTokens) / s.writes).toFixed(0) : 0}% of writes)`,
    '',
    'gap since the previous request | what the agent did last: restarts / tokens',
  ];
  for (const [k, v] of Object.entries(s.byCause).sort((a, b) => b[1].tokens - a[1].tokens)) lines.push(`  ${k}: ${v.n} / ${M(v.tokens)}`);
  lines.push('', 'by role: agents / requests / cold / tokens');
  for (const [k, v] of Object.entries(s.byRole).sort((a, b) => b[1].coldTokens - a[1].coldTokens)) lines.push(`  ${k}: ${v.agents} / ${v.requests} / ${v.cold} / ${M(v.coldTokens)}`);
  const lb = s.longBash;
  lines.push('', `Bash calls of ${LONG_BASH_MIN} min or longer: ${lb.count} (${lb.under8} under 8 min; median ${lb.median} min, p90 ${lb.p90} min)`);
  return lines.join('\n');
}

function main(argv) {
  const json = argv.includes('--json');
  const dirs = argv.filter((a) => !a.startsWith('--'));
  if (!dirs.length) {
    process.stderr.write('usage: node scripts/cold-cache.mjs <project dir>... [--json]\n');
    return 2;
  }
  const analyses = transcriptsUnder(dirs).map((f) => analyseTranscript(parseJsonl(f), roleOf(f)));
  const s = summarise(analyses);
  process.stdout.write((json ? JSON.stringify(s, null, 1) : renderText(s)) + '\n');
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) process.exit(main(process.argv.slice(2)));
