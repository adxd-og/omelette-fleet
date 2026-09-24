#!/usr/bin/env node
/**
 * omelette-fleet :: scripts/context-by-source.mjs
 * Where a sub-agent's context goes, read out of each sub-agent's own
 * transcript — the P0 measurement of the 1.2.0 spec
 * (docs/superpowers/specs/2026-09-20-1.2.0-context-design.md).
 *
 *   node scripts/context-by-source.mjs <session.jsonl> <subagents dir> [--agents] [--json]
 *
 * WHERE THE NUMBERS COME FROM. Claude Code keeps every sub-agent's transcript
 * as <session>/subagents/agent-<id>.jsonl, one entry per content block. One API
 * request is one `message.id` (all the blocks of a request share it); its
 * context is input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens of that message, and its output_tokens is the
 * largest value seen for the id. Per agent: the number of requests, the peak
 * context, the raw usage sums (fresh input, cache writes, cache reads,
 * output) and the first request whose context passed 200 000. No cost is
 * computed: apply the prices to the sums yourself.
 *
 * WHAT "LOGGED TEXT BY SOURCE" IS. The characters each turn added to the
 * transcript, by where they came from: the brief (the first user message);
 * Read results; Bash output of a command that reads a file (any pipeline
 * segment starting with cat, head, tail, less, more, sed -n, git show,
 * git diff, git log -p, nl or bat); other Bash output; Grep/Glob; Edit/Write;
 * other tool results; attachments (the characters of an attachment entry's
 * content); and the agent's own output (thinking, text, and tool inputs as
 * JSON). What it is NOT: the resident context. Text added once is re-sent on
 * every later request; the resident context per request is the usage sum
 * above, reported beside it. Characters, not tokens.
 *
 * ROLES. From the task notifications in the session transcript (parseUsage of
 * ./agent-usage.mjs). Where agent-<id>.meta.json sits beside a transcript
 * (Claude Code 2.1.280 and later), its description wins over the notification
 * and the role is read from it by roleOf.
 *
 * AGGREGATES ONLY. It prints no transcript content and no absolute path: file
 * names are repository-relative, a file outside the repository prints as
 * <outside>/<basename>, and descriptions go through sanitise.
 *
 * Not part of the published package (`files` in package.json leaves scripts/
 * out): it is a measuring tool for whoever wants to repeat the measurement.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseUsage, roleOf, sanitise } from './agent-usage.mjs';

const CROSSING = 200_000;
// Where a tool result came from; the split after the 200 k crossing counts these.
const TOOL_SOURCES = ['read', 'bash-read', 'bash', 'search', 'edit', 'other'];
const SOURCES = ['brief', ...TOOL_SOURCES, 'attachment', 'own'];
const zeros = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));

const READ_CMD = /^\s*(cat|head|tail|less|more|sed\s+-n|git\s+show|git\s+diff|git\s+log\s+-p|nl|bat)\b/;
/** A Bash command reads a file when any segment of it (split at &&, ||, ; and |) starts with a reading command. */
export function isReadCommand(cmd) {
  return String(cmd).split(/\s*(?:&&|\|\||;|\|)\s*/).some((segment) => READ_CMD.test(segment));
}

// A word of a reading Bash command that names a file.
const FILE_WORD = /^[\w./-]+\.(mjs|js|md|json|ts)$/;

/** Characters of message or tool-result content: a string, or blocks (a text block counts its text, any other its JSON). */
const textLength = (c) => typeof c === 'string' ? c.length
  : Array.isArray(c) ? c.reduce((n, b) => n + (b.text ? b.text.length : JSON.stringify(b).length), 0) : 0;

const REPO_PREFIX = /^.*?[\\/]omelette-fleet[\\/]/;
const ABSOLUTE = /^(?:[\\/]|~|[A-Za-z]:)/;
/** A file as this repository names it; anything outside it keeps only its basename. */
function repoRelative(path) {
  const p = String(path);
  if (REPO_PREFIX.test(p)) return p.replace(REPO_PREFIX, '');
  return ABSOLUTE.test(p) ? `<outside>/${p.split(/[\\/]/).pop()}` : p;
}

/**
 * One sub-agent's transcript, measured.
 * @param {object[]} lines the parsed JSONL entries of the transcript
 * @param {{role:string, description:string}} [meta] who the agent was
 */
export function analyseTranscript(lines, meta) {
  const tools = new Map(); // tool_use id -> { name, input }
  const requests = []; const byMessage = new Map(); // message.id -> request
  const src = zeros(SOURCES);
  const files = new Map(); // file -> reads (Read calls and files named by a reading Bash command)
  const ranges = new Map(); // file -> [from, to) line ranges Read so far
  let model = null, briefSeen = false, compactions = 0, readCalls = 0, overlappingReads = 0, crossing = null;
  const countFile = (f) => files.set(f, (files.get(f) || 0) + 1);

  for (const e of lines) {
    const m = e.message || {};
    if (e.type === 'assistant') {
      model = model || m.model;
      const u = m.usage || {};
      const seen = m.id && byMessage.get(m.id);
      if (seen) seen.output = Math.max(seen.output, u.output_tokens || 0);
      else if (m.id) {
        const request = { input: u.input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 };
        request.context = request.input + request.cacheWrite + request.cacheRead;
        byMessage.set(m.id, request); requests.push(request);
        if (!crossing && request.context > CROSSING) crossing = { at: requests.length, src: zeros(TOOL_SOURCES) };
      }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'tool_use') { tools.set(b.id, { name: b.name, input: b.input || {} }); src.own += JSON.stringify(b.input || {}).length; }
        else if (b.type === 'thinking') src.own += (b.thinking || '').length;
        else if (b.type === 'text') src.own += (b.text || '').length;
      }
    } else if (e.type === 'user') {
      if (!briefSeen) { briefSeen = true; src.brief += textLength(m.content); continue; }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type !== 'tool_result') continue;
        const { name, input } = tools.get(b.tool_use_id) || { name: '?', input: {} };
        let source = 'other';
        if (name === 'Read') {
          source = 'read';
          const f = repoRelative(input.file_path); countFile(f);
          const from = input.offset || 1, to = input.limit ? from + input.limit : Infinity; // no offset: from the top; no limit: to the end
          const earlier = ranges.get(f) || [];
          readCalls++;
          if (earlier.some(([a, z]) => from < z && a < to)) overlappingReads++;
          earlier.push([from, to]); ranges.set(f, earlier);
        } else if (name === 'Bash') {
          source = isReadCommand(input.command) ? 'bash-read' : 'bash';
          if (source === 'bash-read') for (const w of String(input.command).split(/\s+/)) if (FILE_WORD.test(w)) countFile(repoRelative(w));
        } else if (name === 'Grep' || name === 'Glob') source = 'search';
        else if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') source = 'edit';
        const chars = textLength(b.content);
        src[source] += chars;
        if (crossing) crossing.src[source] += chars;
      }
    } else if (e.type === 'attachment') {
      src.attachment += textLength(e.attachment?.content ?? e.attachment ?? '');
    } else if (e.type === 'system' && /compact/i.test(e.subtype || '')) compactions++;
  }

  const sum = (k) => requests.reduce((s, r) => s + r[k], 0);
  const reads = [...files.values()];
  return {
    role: meta?.role || 'unknown',
    description: sanitise(meta?.description || ''),
    model,
    requests: requests.length,
    peak: requests.reduce((p, r) => Math.max(p, r.context), 0),
    usage: { input: sum('input'), cacheWrite: sum('cacheWrite'), cacheRead: sum('cacheRead'), output: sum('output') },
    src,
    files,
    totalReads: reads.reduce((s, n) => s + n, 0),
    repeated: reads.filter((n) => n > 1).reduce((s, n) => s + n - 1, 0),
    readCalls,
    overlappingReads,
    compactions,
    crossing,
  };
}

/** Totals per role (largest summed peak first), the files planners and coders read most, and who crossed 200 k. */
export function summarise(records) {
  const roles = new Map();
  for (const r of records) {
    const t = roles.get(r.role) || { role: r.role, agents: 0, peakSum: 0, requests: 0, src: zeros(SOURCES), totalReads: 0, repeated: 0, readCalls: 0, overlappingReads: 0, crossed: 0 };
    t.agents++; t.peakSum += r.peak; t.requests += r.requests; t.totalReads += r.totalReads; t.repeated += r.repeated;
    t.readCalls += r.readCalls; t.overlappingReads += r.overlappingReads; if (r.crossing) t.crossed++;
    for (const k in r.src) t.src[k] += r.src[k];
    roles.set(r.role, t);
  }
  const topFiles = (role) => {
    const reads = new Map();
    for (const r of records) if (r.role === role) for (const [f, c] of r.files) reads.set(f, (reads.get(f) || 0) + c);
    return [...reads.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([file, count]) => ({ file, reads: count }));
  };
  const crossedRecords = records.filter((r) => r.crossing);
  const after = zeros(TOOL_SOURCES);
  for (const r of crossedRecords) for (const k in after) after[k] += r.crossing.src[k];
  return {
    byRole: [...roles.values()].sort((a, b) => b.peakSum - a.peakSum),
    topFiles: { planner: topFiles('planner'), coder: topFiles('coder') },
    crossed: { agents: crossedRecords.length, of: records.length, at: crossedRecords.map((r) => r.crossing.at), requests: crossedRecords.map((r) => r.requests), src: after },
    models: [...new Set(records.map((r) => r.model))],
    compactions: records.reduce((s, r) => s + r.compactions, 0),
  };
}

const n = (x) => Math.round(x).toLocaleString('en-US').replace(/,/g, ' ');
const pct = (part, whole) => whole ? `${Math.round(100 * part / whole)} %` : '–';
const total = (src) => Object.values(src).reduce((a, b) => a + b, 0);

/** The role table, the files read most, the 200 k line; with `agents`, a table per agent. */
export function renderMarkdown(summary, records, { agents = false } = {}) {
  const out = [
    '| Role | Agents | Mean peak context (tokens) | Mean requests | Logged text by source (chars): brief · Read · Bash-read · Bash other · Grep/Glob · Edit · attachments · own output (thinking, text, tool inputs) | Read calls whose range overlaps an earlier Read of the same file | Crossed 200k |',
    '|---|---:|---:|---:|---|---:|---:|',
  ];
  for (const t of summary.byRole) {
    const s = t.src; const tot = total(s); // `other` tool results count in the total, not in a column
    out.push(`| ${t.role} | ${t.agents} | ${n(t.peakSum / t.agents)} | ${n(t.requests / t.agents)} | ${pct(s.brief, tot)} · ${pct(s.read, tot)} · ${pct(s['bash-read'], tot)} · ${pct(s.bash, tot)} · ${pct(s.search, tot)} · ${pct(s.edit, tot)} · ${pct(s.attachment, tot)} · ${pct(s.own, tot)} (${n(tot)}) | ${t.overlappingReads} of ${t.readCalls} | ${t.crossed} |`);
  }
  for (const role of ['planner', 'coder']) {
    const agentCount = summary.byRole.find((t) => t.role === role)?.agents || 0;
    out.push('', `${role}s — files read most (reads across all ${agentCount} agents): ` + summary.topFiles[role].map(({ file, reads }) => `${file} ×${reads}`).join(' · '));
  }
  const c = summary.crossed; const tot = total(c.src);
  out.push('', `Crossed 200k: ${c.agents} of ${c.of}. After the crossing, logged input by source (chars), summed:`,
    Object.entries(c.src).map(([k, v]) => `${k} ${pct(v, tot)}`).join(' · ') + ` (${n(tot)} chars); crossing at request ${c.at.join(', ')} of ${c.requests.join(', ')}`,
    `Compaction markers seen in sub-agent transcripts: ${summary.compactions}. Models: ${summary.models.join(', ')}`);
  if (agents) {
    out.push('', '| Agent | Role | Model | Requests | Peak ctx | Fresh input tok Σ | Cache-write tok Σ | Cache-read tok Σ | Output tok Σ | Read | Bash-read | Bash | Own | Overlapping reads |',
      '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of [...records].sort((a, b) => b.peak - a.peak)) {
      const u = r.usage;
      out.push(`| ${r.description.slice(0, 40).replace(/\|/g, '\\|')} | ${r.role} | ${r.model} | ${r.requests} | ${n(r.peak)} | ${n(u.input)} | ${n(u.cacheWrite)} | ${n(u.cacheRead)} | ${n(u.output)} | ${n(r.src.read)} | ${n(r.src['bash-read'])} | ${n(r.src.bash)} | ${n(r.src.own)} | ${r.overlappingReads}/${r.readCalls} |`);
    }
  }
  return out.join('\n');
}

/** The role a .meta.json `agentType` names outright (a definition's name), or null to fall back to the description. */
const ROLE_OF_TYPE = { 'omelette-coder': 'coder', 'omelette-tester': 'tester', 'omelette-lead': 'lead', planner: 'planner', 'test-verifier': 'tester', executor: 'coder' };
function roleOfType(agentType) {
  if (typeof agentType !== 'string') return null;
  return ROLE_OF_TYPE[agentType] || ROLE_OF_TYPE[agentType.replace(/-(medium|high|xhigh|max|low)$/, '')] || null;
}

/** Who an agent was: its .meta.json when readable (role by agentType, else by roleOf on the description), else its task notification. */
function metaFor(dir, id, notified) {
  const file = join(dir, `agent-${id}.meta.json`);
  if (existsSync(file)) {
    try {
      const { agentType, description } = JSON.parse(readFileSync(file, 'utf8'));
      const label = typeof description === 'string' ? sanitise(description) : '';
      const role = roleOfType(agentType) || (label ? roleOf(label) : null);
      if (role) return { role, description: label };
    } catch { /* unreadable: fall back to the notification */ }
  }
  const row = notified.get(id);
  return row && { role: row.role, description: row.description };
}

function fail(message) { console.error(`context-by-source: ${message}`); process.exit(2); }

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  // --before <ISO date>: only transcripts whose first entry is older — a resumed
  // session keeps writing into the same subagents/ directory, so a published
  // table names its cutoff to stay reproducible.
  const at = args.indexOf('--before');
  const before = at === -1 ? null : args.splice(at, 2)[1];
  const [session, dir] = args.filter((a) => !a.startsWith('--'));
  if (!session || !dir || (at !== -1 && !before)) { console.error('usage: node scripts/context-by-source.mjs <session.jsonl> <subagents dir> [--agents] [--json] [--before <ISO date>]'); process.exit(2); }
  let sessionText, names;
  try { sessionText = readFileSync(session, 'utf8'); } catch (e) { fail(`cannot read ${basename(session)}: ${e.code || e.message}`); }
  try { names = readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/.test(f)); } catch (e) { fail(`cannot read ${basename(dir)}: ${e.code || e.message}`); }
  const notified = new Map(parseUsage(sessionText).map((r) => [r.id, r]));
  const records = names.map((f) => {
    const id = f.replace(/^agent-|\.jsonl$/g, '');
    let text;
    try { text = readFileSync(join(dir, f), 'utf8'); } catch (e) { fail(`cannot read ${f}: ${e.code || e.message}`); }
    // Physical line numbers in errors (blank lines count); an entry that is
    // valid JSON but not an object is an error too, never an uncaught throw
    // whose stack would name this checkout's absolute path.
    const lines = [];
    text.split('\n').forEach((l, i) => {
      if (!l.trim()) return;
      let e; try { e = JSON.parse(l); } catch { return fail(`${f} line ${i + 1} is not JSON`); }
      if (!e || typeof e !== 'object' || Array.isArray(e)) return fail(`${f} line ${i + 1} is not a transcript entry`);
      lines.push(e);
    });
    if (before && lines[0] && lines[0].timestamp && Date.parse(lines[0].timestamp) >= Date.parse(before)) return null;
    return { id, ...analyseTranscript(lines, metaFor(dir, id, notified)) };
  }).filter(Boolean);
  const summary = summarise(records);
  const mapsAsObjects = (k, v) => v instanceof Map ? Object.fromEntries(v) : v;
  console.log(args.includes('--json') ? JSON.stringify({ summary, records }, mapsAsObjects, 2) : renderMarkdown(summary, records, { agents: args.includes('--agents') }));
}
