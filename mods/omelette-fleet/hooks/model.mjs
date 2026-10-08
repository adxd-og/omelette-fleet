/**
 * omelette-fleet :: mods/omelette-fleet/hooks/model.mjs
 * The fleet model (1.7.0): one pure reducer, (state, event) → state, from the
 * events register.tsx makes of the engine's to the nodes, links and history
 * the pane draws. It never mutates its input and imports nothing but its
 * neighbours, so `npm test` runs it without Claude Code.
 *
 * A node's `since` is when what it shows began: a unit's or a loop's current
 * call, an agent's spawn, resume, stop or status change. A tick measures an
 * activity's age from it.
 */

/** @import { FleetSnapshot } from './feed.mjs' */

/**
 * @typedef {{ id: string, kind: 'orchestrator'|'agent'|'unit', role: string, parentId?: string,
 *   model?: string, effort?: string, status: 'running'|'waiting'|'idle'|'reported',
 *   activity?: string, activityCallId?: string, since: number, callerId?: string,
 *   feed?: 'ok'|'none', lastEndedAt?: number, order: number,
 *   openCalls?: { callId: string, callerId: string, tool: string, since: number }[],
 *   loopCalls?: { callId: string, subject: string, since: number }[] }} FleetNode
 *   `openCalls`: a unit's calls of this session still out; the unit shows the newest.
 *   `loopCalls`: a loop's own calls still out (the main loop's or an agent's); the loop shows the newest.
 */
/** @typedef {{ at: number, from: string, to: string, label: string }} FleetLink  node ids, or a SendMessage's raw target */
/** @typedef {{ contextPercent?: number, fiveHour?: number, sevenDay?: number }} FleetUsage */
/** @typedef {{ nodes: FleetNode[], history: FleetLink[], usage: FleetUsage, now: number, isOpen: boolean }} FleetState */
/**
 * @typedef {{ type: 'spawn', at: number, agentId: string, role: string, parentId?: string, model?: string }
 *   | { type: 'step', at: number, agentId: string, model?: string, effort?: string }
 *   | { type: 'call', at: number, agentId: string, callId: string, tool: string, subject?: string, target?: string }
 *   | { type: 'return', at: number, agentId: string, callId: string }
 *   | { type: 'settle', at: number, agentId: string }
 *   | { type: 'stop', at: number, agentId: string }
 *   | { type: 'agents', at: number, list: { id: string, type: string, status: string, parentId?: string }[] }
 *   | { type: 'feed', at: number, snapshots: FleetSnapshot[] }
 *   | { type: 'usage', at: number, usage: FleetUsage }
 *   | { type: 'tick' | 'open' | 'close', at: number }} FleetEvent
 */

export const UNITS = Object.freeze(['gemini', 'grok', 'codex']);
export const MAIN = 'main';

/** The newest links kept. */
const HISTORY_CAP = 200;
/**
 * An activity older than this is a call whose return never came (an interrupted
 * turn), and a feed snapshot still listing a call after it is left by a process
 * that is gone: above the longest legitimate unit call, since a unit's timeoutS
 * has no fixed ceiling and a default deep research runs about 36 minutes.
 */
export const STALE_MS = 2 * 60 * 60 * 1000;
/** The open calls a unit or a loop keeps, the oldest dropped past it. */
const OPEN_CALLS_CAP = 20;
/** Another session's call on a unit, as `callerId`. */
const OTHER = 'other';

/**
 * The engine's AgentStatus as the pane reads it: an ended agent has reported;
 * one held (on its own background work, a plan's approval, an Agent call) and
 * a teammate idle until a message wakes it are both waiting; one not yet
 * started is running, like a fresh spawn.
 */
const AGENT_STATUS = Object.freeze({
  pending: 'running',
  running: 'running',
  waiting: 'waiting',
  idle: 'waiting',
  completed: 'reported',
  failed: 'reported',
  killed: 'reported',
});

const unitId = (unit) => `unit:${unit}`;

/**
 * The orchestrator (id 'main') and the three units (ids 'unit:<name>'), all idle,
 * the units without a feed; no agents, no history.
 * @param {number} now
 * @returns {FleetState}
 */
export function initialState(now) {
  return {
    nodes: [
      { id: MAIN, kind: 'orchestrator', role: 'orchestrator', status: 'idle', since: now, order: 0 },
      ...UNITS.map((unit, i) => ({ id: unitId(unit), kind: /** @type {const} */ ('unit'), role: unit, status: /** @type {const} */ ('idle'), since: now, feed: /** @type {const} */ ('none'), order: i + 1 })),
    ],
    history: [],
    usage: {},
    now,
    isOpen: false,
  };
}

/**
 * A unit's MCP tool, under any server prefix: `mcp__<server>__<unit>_<tool>`.
 * @param {string} tool
 * @returns {{ unit: string, tool: string } | null}
 */
export function unitOfTool(tool) {
  if (typeof tool !== 'string' || !tool.startsWith('mcp__')) return null;
  const sep = tool.lastIndexOf('__');
  if (sep < 'mcp__'.length) return null;
  const name = tool.slice(sep + 2);
  for (const unit of UNITS) {
    if (name.startsWith(`${unit}_`) && name.length > unit.length + 1) return { unit, tool: name.slice(unit.length + 1) };
  }
  return null;
}

/** `node` with `patch` applied; a key patched to `undefined` is removed. */
function patched(node, patch) {
  const out = { ...node, ...patch };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return /** @type {FleetNode} */ (out);
}

/** `state` with the node `id` patched (no node by that id: the state as given). */
function withNode(state, id, patch) {
  if (!state.nodes.some((n) => n.id === id)) return state;
  return { ...state, nodes: state.nodes.map((n) => (n.id === id ? patched(n, patch) : n)) };
}

/** `state` with `link` appended to the history, the oldest dropped past the cap. */
function withLink(state, link) {
  return { ...state, history: [...state.history, link].slice(-HISTORY_CAP) };
}

const find = (state, id) => state.nodes.find((n) => n.id === id);
const findAgent = (state, id) => state.nodes.find((n) => n.id === id && n.kind === 'agent');
const nextOrder = (state) => Math.max(...state.nodes.map((n) => n.order)) + 1;

/** What a node shows once its calls are over. */
const NO_ACTIVITY = Object.freeze({ activity: undefined, activityCallId: undefined, loopCalls: undefined });
/** A unit with no call running. */
const UNIT_IDLE = Object.freeze({ ...NO_ACTIVITY, status: 'idle', callerId: undefined, openCalls: undefined });

/** A unit's fields once `open` are its calls still out: idle when none is, else the newest shows. */
function unitHolding(open) {
  if (open.length === 0) return UNIT_IDLE;
  const newest = open.reduce((a, b) => (b.since >= a.since ? b : a));
  return { status: 'running', openCalls: open, callerId: newest.callerId, activity: newest.tool, activityCallId: newest.callId, since: newest.since };
}

/** `state` with every unit's open calls narrowed to those `keep` accepts; a unit that lost one is shown anew. */
function withUnitCalls(state, keep, idlePatch = {}) {
  let next = state;
  for (const unit of state.nodes) {
    if (unit.kind !== 'unit' || !unit.openCalls) continue;
    const open = unit.openCalls.filter(keep);
    if (open.length === unit.openCalls.length) continue;
    if (open.length === 0) {
      next = withNode(next, unit.id, { ...UNIT_IDLE, ...idlePatch });
      continue;
    }
    const holding = unitHolding(open);
    // Falling back to an older call: the model and effort were the newer one's; the feed sets them again.
    const fellBack = holding.activityCallId !== unit.activityCallId;
    next = withNode(next, unit.id, fellBack ? { ...holding, model: undefined, effort: undefined } : holding);
  }
  return next;
}

/** A loop's fields once `open` are its calls still out: no activity when none is, else the newest shows. */
function loopHolding(open) {
  if (open.length === 0) return NO_ACTIVITY;
  const newest = open.reduce((a, b) => (b.since >= a.since ? b : a));
  return { loopCalls: open, activity: newest.subject, activityCallId: newest.callId, since: newest.since };
}

/** `state` with the open calls of `loop` narrowed to those `keep` accepts; a loop that lost one is shown anew. */
function withLoopCalls(state, loop, keep) {
  const open = loop.loopCalls ?? [];
  const left = open.filter(keep);
  return left.length === open.length ? state : withNode(state, loop.id, loopHolding(left));
}

/** @type {Record<string, (state: FleetState, e: any) => FleetState>} */
const ON = {
  spawn(state, e) {
    if (typeof e.agentId !== 'string' || !e.agentId) return state;
    const parentId = e.parentId || MAIN;
    const known = findAgent(state, e.agentId);
    if (!known && find(state, e.agentId)) return state;
    const fields = { role: e.role || known?.role || 'agent', parentId, model: e.model ?? known?.model, status: 'running', since: e.at };
    const next = known
      ? withNode(state, e.agentId, fields)
      : { ...state, nodes: [...state.nodes, patched({ id: e.agentId, kind: 'agent', ...fields, order: nextOrder(state) }, {})] };
    return withLink(next, { at: e.at, from: parentId, to: e.agentId, label: 'Agent' });
  },

  step(state, e) {
    const loop = find(state, e.agentId);
    if (!loop || loop.kind === 'unit') return state;
    const resumed = loop.status === 'reported' ? { status: 'running', since: e.at } : {};
    return withNode(state, loop.id, { model: e.model, effort: e.effort, ...resumed });
  },

  call(state, e) {
    const unit = unitOfTool(e.tool);
    let next = state;
    const loop = find(state, e.agentId);
    if (loop && loop.kind !== 'unit') {
      const subject = e.subject || e.tool;
      // Held open until its return, like a unit's; a call with no id could never be matched by its return, so it only shows.
      const open = e.callId ? { loopCalls: [...(loop.loopCalls ?? []), { callId: e.callId, subject, since: e.at }].slice(-OPEN_CALLS_CAP) } : {};
      next = withNode(next, loop.id, { ...open, activity: subject, activityCallId: e.callId, status: 'running', since: e.at });
    }
    if (unit) {
      const to = unitId(unit.unit);
      // A call with no id could never be matched by its return: it holds nothing open.
      if (e.callId) {
        const open = [...(find(next, to).openCalls ?? []), { callId: e.callId, callerId: e.agentId, tool: unit.tool, since: e.at }];
        next = withNode(next, to, unitHolding(open.slice(-OPEN_CALLS_CAP)));
      }
      next = withLink(next, { at: e.at, from: e.agentId, to, label: unit.tool });
    } else if (e.tool === 'SendMessage' && typeof e.target === 'string' && e.target) {
      // An agent id or 'main' is the node's id; a name no node carries stays as written.
      next = withLink(next, { at: e.at, from: e.agentId, to: e.target, label: 'SendMessage' });
    }
    return next;
  },

  return(state, e) {
    if (!e.callId) return state;
    let next = state;
    const loop = find(state, e.agentId);
    if (loop && loop.kind !== 'unit') next = withLoopCalls(next, loop, (c) => c.callId !== e.callId);
    return withUnitCalls(next, (c) => c.callId !== e.callId, { lastEndedAt: e.at });
  },

  // A loop asks the model again only once its tool results are back: a call still open in it is one whose return never came.
  settle(state, e) {
    const loop = find(state, e.agentId);
    // A call with no id is shown but never held: its activity is settled too.
    if (!loop || loop.kind === 'unit' || (!loop.loopCalls && loop.activity === undefined)) return state;
    // Its unit calls are over too: a unit call is one of the loop's tool calls.
    return withUnitCalls(withNode(state, loop.id, NO_ACTIVITY), (c) => c.callerId !== loop.id);
  },

  stop(state, e) {
    const agent = findAgent(state, e.agentId);
    if (!agent) return state;
    let next = withNode(state, agent.id, { ...NO_ACTIVITY, status: 'reported', since: e.at });
    // A unit call of the stopped agent that never returned is over with it.
    next = withUnitCalls(next, (c) => c.callerId !== agent.id);
    return withLink(next, { at: e.at, from: agent.id, to: agent.parentId || MAIN, label: 'report' });
  },

  agents(state, e) {
    let next = state;
    for (const listed of Array.isArray(e.list) ? e.list : []) {
      if (!listed || typeof listed.id !== 'string' || !listed.id) continue;
      const status = AGENT_STATUS[listed.status];
      const known = find(next, listed.id);
      if (!known) {
        const added = patched({ id: listed.id, kind: 'agent', role: listed.type || 'agent', parentId: listed.parentId || MAIN, status: status ?? 'running', since: e.at, order: nextOrder(next) }, {});
        next = { ...next, nodes: [...next.nodes, added] };
        continue;
      }
      if (known.kind !== 'agent' || !status || status === known.status) continue;
      // SubagentStop said it reported; the engine lists a finished teammate as idle.
      if (known.status === 'reported' && listed.status === 'idle') continue;
      next = withNode(next, known.id, { ...(status === 'reported' ? NO_ACTIVITY : {}), status, since: e.at });
    }
    return next;
  },

  feed(state, e) {
    const snapshots = (Array.isArray(e.snapshots) ? e.snapshots : []).filter((s) => s && typeof s === 'object');
    let next = state;
    for (const unit of UNITS) {
      const id = unitId(unit);
      const node = find(next, id);
      const own = snapshots.filter((s) => s.unit === unit);
      const isOther = node.status === 'running' && node.callerId === OTHER;
      if (own.length === 0) {
        next = withNode(next, id, { feed: 'none', ...(isOther ? UNIT_IDLE : {}) });
        continue;
      }
      const active = own.flatMap((s) => (Array.isArray(s.active) ? s.active : []));
      const ended = Math.max(...own.map((s) => (Number.isFinite(s.lastEndedAt) ? s.lastEndedAt : -Infinity)));
      /** @type {Partial<FleetNode>} */
      const patch = { feed: 'ok' };
      if (Number.isFinite(ended) && !(node.lastEndedAt >= ended)) patch.lastEndedAt = ended;
      if (node.status === 'running' && !isOther) {
        // This session's call: the feed's entry for the same tool that started nearest to it.
        const call = nearest(active.filter((a) => a.tool === `${unit}_${node.activity}`), node.since);
        if (call) Object.assign(patch, { model: call.model ?? undefined, effort: call.effort ?? undefined, since: call.startedAt });
      } else {
        const call = active.reduce((a, b) => (a && a.startedAt >= b.startedAt ? a : b), undefined);
        if (call) {
          const tool = call.tool.startsWith(`${unit}_`) ? call.tool.slice(unit.length + 1) : call.tool;
          Object.assign(patch, { status: 'running', callerId: OTHER, activity: tool, activityCallId: undefined, since: call.startedAt, model: call.model ?? undefined, effort: call.effort ?? undefined });
        } else if (isOther) {
          Object.assign(patch, UNIT_IDLE);
        }
      }
      next = withNode(next, id, patch);
    }
    return next;
  },

  usage(state, e) {
    return { ...state, usage: { ...e.usage } };
  },

  tick(state, e) {
    const isOld = (since) => e.at - since > STALE_MS;
    const keep = (c) => !isOld(c.since);
    // A unit or a loop with open calls loses only the old ones; an activity with none (another session's call, a call with no id) goes by its since.
    const stale = (n) => n.activity !== undefined && !n.openCalls && !n.loopCalls && isOld(n.since);
    const next = {
      ...state,
      now: e.at,
      nodes: state.nodes.map((n) => (stale(n) ? patched(n, n.kind === 'unit' ? UNIT_IDLE : NO_ACTIVITY) : n)),
    };
    const loops = next.nodes.filter((n) => n.kind !== 'unit');
    return withUnitCalls(loops.reduce((acc, loop) => withLoopCalls(acc, loop, keep), next), keep);
  },

  open: (state) => ({ ...state, isOpen: true }),
  close: (state) => ({ ...state, isOpen: false }),
};

/** The entry of `calls` whose start is nearest to `at`. */
function nearest(calls, at) {
  return calls.reduce((a, b) => (a && Math.abs(a.startedAt - at) <= Math.abs(b.startedAt - at) ? a : b), undefined);
}

/**
 * The model after one event. Pure: returns a new state and never mutates its
 * input; an unknown event type returns the state as given.
 * @param {FleetState} state
 * @param {FleetEvent} event
 * @returns {FleetState}
 */
export function reduce(state, event) {
  const type = event?.type;
  if (typeof type !== 'string' || !Object.hasOwn(ON, type)) return state;
  return ON[type](state, event);
}
