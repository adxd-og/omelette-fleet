/**
 * omelette-fleet :: mods/omelette-fleet/hooks/register.tsx
 * The fleet pane's hooks module (1.7.0): the one file of the mod that calls
 * `$` and draws. Each hook turns an engine event into a fleet-model event
 * (model.mjs), writes the state, and hands the engine's own result back as it
 * received it; the render hook draws layout.mjs's rows. The mod observes: it
 * never rewrites or blocks, and a failure of its own bookkeeping never reaches
 * an event (every state write goes through `apply`, which cannot throw). The
 * one refusal it answers is the rendered guard's (guard v2, 1.8.0, guard.mjs):
 * exit 2 from the script is `{ deny }`; anything else, its own failures
 * included, lets the call go on. The one rewrite is the pin (1.8.0, roles.mjs):
 * a guarded role spawned on a model its definition does not name runs on the
 * definition's. The handoff (1.8.0, handoff.mjs) adds to what the session is
 * sent: the rendered guard's print as a prompt.context block, the settings
 * hook's copy of it taken out of SessionStart's context; and, with
 * `handoffGate` on, one compaction is skipped while the newest open ledger has
 * no fresh handoff.
 *
 * `$` is always spelled `$.noun.method(...)` literally: the engine scans this
 * source and refuses a call it did not see.
 */
import { read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Frozen, FsEntry, PluginOptions, Register, SessionUsage, Timer } from 'claude-code'

import type { FleetState } from '../types'
import { parseSnapshot, snapshotNames } from './feed.mjs'
import { askGuard, findGuardScript, printHandoff, toPreToolUse, touchedLine, touchedPath } from './guard.mjs'
import { HANDOFF_MARKER, lastHandoffFresh, newestOpenLedger } from './handoff.mjs'
import { headerRow, historyRows, layout, statusLine } from './layout.mjs'
import { initialState, MAIN, reduce, roleOf } from './model.mjs'
import { namesModel, readRoleDefinitions } from './roles.mjs'
import { svgOf } from './svg.mjs'
import { subjectOf } from './text.mjs'

const PANE = 'omelette-fleet'
const TITLE = 'Fleet'
const fleet = { plugin: 'omelette-fleet', key: 'fleet' } as const
/** When the handoff gate last skipped a compaction (1.8.0): the next one within GATE_PASS_MS passes. */
const handoffSkip = { plugin: 'omelette-fleet', key: 'handoffSkipAt' } as const

/** The handoff gate's skip, the notice it reads as, and how long after a skip the next compaction passes. */
const GATE_SKIP = 'no handoff in the last 30 minutes: write one, then compact again'
const GATE_PASS_MS = 10 * 60 * 1000

/**
 * The pane's tick while it is open: every 250 ms while an agent or a unit runs
 * and motion is on (the spinner's frame), every second otherwise. The status
 * feed and the agent list are read when the pane is drawn, then at most every 2 s.
 */
const FAST_MS = 250
const SLOW_MS = 1000
const FEED_MS = 2000

/** A fleet-model event before its time is stamped (model.mjs, FleetEvent). */
type ModelEvent = { readonly type: string; readonly [field: string]: unknown }
type Tone = 'plain' | 'live' | 'dim'

/**
 * The tick's chain of one-shot timers: the generation it started under, and
 * its one pending timer, each tick arming the next at the rate the state asks
 * for once it is over (so a chain never overlaps itself).
 */
type Chain = { readonly generation: number; timer?: Timer }

/**
 * The tick's own state, all a module variable holds: the running chain, the
 * generation the newest chain started under, when the feed was last read, and
 * the surface the pane was last drawn on (the fast tick is the terminal's
 * spinner; a redraw four times a second would restart the SVG's own
 * animations). A reload drops them, the surface becoming unknown (the slow
 * tick) until the next draw, and `session.start` starts the tick again.
 */
let ticker: Chain | undefined
let generation = 0
/** Opens of the pane by this module (the command, autoOpen): a close that waited across one stops nothing. */
let opens = 0
/** When the closed pane's status line last refreshed the agent list. */
let agentsReadAt = -Infinity
const AGENTS_MS = 5_000
let feedReadAt = Number.NEGATIVE_INFINITY
let drawnOn: string | undefined

/** A guarded role's definition, its frontmatter's `model:` and `effort:` (roles.mjs). */
type RoleDefinition = { readonly model?: string; readonly effort?: string }

/** The guarded roles' definitions, read at each `session.start` (a reload's too); none before one. */
let definitions: Promise<Map<string, RoleDefinition>> | undefined
/** The agents whose effort was flagged since this module loaded; the row's flag in the state keeps it once across a reload. */
const flagged = new Set<string>()

/** Whether the chain of `gen` is the one running: a tick, an open or a feed read of an older chain writes nothing. */
const isCurrent = (gen: number): boolean => ticker?.generation === gen
/** No chain runs: a close may be written. */
const isStopped = (): boolean => ticker === undefined

/** Thrown inside a write of a chain stopped since its tick or open began: `update` writes nothing. */
const STALE = new Error('the chain stopped')

/**
 * Applies model events at the engine's time in one state write (`update`
 * retries on a concurrent write), then sets the status line: the running
 * actors while the pane is closed, nothing while it is open. With `gen`, the
 * write is made only while that chain runs (or, given a check, while it holds),
 * checked at the write itself: `update` writes with `ifVersion` and re-runs the
 * check on a miss.
 * Never throws.
 */
const apply = async ($: EngineInterface, events: readonly ModelEvent[], gen?: number | (() => boolean)): Promise<FleetState | undefined> => {
  try {
    const at = await $.clock.now()
    const state: FleetState = await update($, fleet, value => {
      if (typeof gen === 'function' ? !gen() : gen !== undefined && !isCurrent(gen)) {
        throw STALE
      }

      return events.reduce((acc: FleetState, event) => reduce(acc, { ...event, at }), value ?? initialState(at))
    })

    $.ui.status(state.isOpen ? undefined : statusLine(state, at))

    return state
  } catch {
    return undefined
  }
}

/** The engine's usage figures as the model keeps them (the pane draws no cost); a figure the engine does not have is left out. */
const usageOf = (usage: Frozen<Pick<SessionUsage, 'context' | 'rateLimits'>>): Record<string, number> => {
  const figures: Record<string, number | undefined> = {
    contextPercent: usage.context?.percent,
    fiveHour: usage.rateLimits?.find(limit => limit.kind === 'five_hour')?.percentUsed,
    sevenDay: usage.rateLimits?.find(limit => limit.kind === 'seven_day')?.percentUsed,
  }

  return Object.fromEntries(Object.entries(figures).filter(([, value]) => typeof value === 'number')) as Record<string, number>
}

/** The engine's agent list as the model's `agents` event. */
const agentsEvent = (agents: readonly AgentInfo[]): ModelEvent => ({
  type: 'agents',
  list: agents.map(agent => ({ id: agent.id, type: agent.type, status: agent.status, parentId: agent.parentId })),
})

/** The fleet home: `$OMELETTE_HOME` trimmed, else (unset or blank) `~/.omelette`. */
const fleetHome = async ($: EngineInterface): Promise<string | undefined> => {
  const own = (await $.env.get('OMELETTE_HOME'))?.trim()

  if (own) {
    return own
  }

  const home = await $.env.get('HOME')

  return home ? `${home}/.omelette` : undefined
}

/** The units' status snapshots under the fleet home (schema 2); none when there is no home or nothing readable. */
const readFeed = async ($: EngineInterface): Promise<unknown[]> => {
  const home = await fleetHome($)

  if (!home) {
    return []
  }

  let entries: FsEntry[]

  try {
    entries = await $.fs.list(home)
  } catch {
    return []
  }

  const now = await $.clock.now()
  const snapshots: unknown[] = []

  for (const name of snapshotNames(entries.filter(entry => entry.kind === 'file').map(entry => entry.name))) {
    try {
      const snapshot = parseSnapshot(await $.fs.read(`${home}/${name}`), now)

      if (snapshot) {
        snapshots.push(snapshot)
      }
    } catch {
      // Rewritten or removed between the listing and the read: the next tick reads it.
    }
  }

  return snapshots
}

/**
 * What the pane reads beside the events, now, for the chain of `gen`: the
 * status feed, and the agent list (an idle teammate or a held background
 * agent raises no SubagentStop, so only the list says it stopped running).
 * The time of the read is kept for the next one's due time, by the running
 * chain only. A source that cannot be read is left out.
 */
const sourcesNow = async ($: EngineInterface, gen: number): Promise<ModelEvent[]> => {
  const at = await $.clock.now()

  if (isCurrent(gen)) {
    feedReadAt = at
  }

  const snapshots = await readFeed($).catch(() => undefined)
  const agents = await $.agent.list().catch(() => undefined)

  return [...(agents ? [agentsEvent(agents)] : []), ...(snapshots ? [{ type: 'feed', snapshots }] : [])]
}

/** Whether the pane's spinner moves now: it is drawn, last on the terminal, motion is on, and an agent or a unit runs. */
const isMoving = (state: FleetState | undefined, isAnimated: boolean): boolean =>
  isAnimated && drawnOn === 'terminal' && state?.isOpen === true && state.nodes.some(node => node.kind !== 'orchestrator' && node.status === 'running')

/**
 * The pane is drawn, for the chain of `gen`: the model knows it, its clock
 * moves, and the status feed and the agent list are read now, not at the next
 * due tick; written only while that chain runs. Never throws.
 */
const markOpen = async ($: EngineInterface, gen: number): Promise<void> => {
  const sources = await sourcesNow($, gen).catch(() => [])

  await apply($, [{ type: 'open' }, { type: 'tick' }, ...sources], gen)
}

/**
 * One tick of the chain of `gen`: whether the pane is still open and drawn;
 * once it is drawn, the model's clock, and the status feed and the agent list
 * when they are due or the pane has just been drawn; then the chain's next
 * tick, 250 ms on while something moves, else a second. A pane opened unasked
 * on a narrow terminal waits undrawn and is seated later without an event:
 * until then a tick asks for the panes and writes nothing. A tick of a chain
 * stopped since it began (the pane closed, maybe opened again, while it waited
 * on the engine) writes nothing, stops nothing and arms nothing. Never throws.
 */
const tick = async ($: EngineInterface, gen: number, isAnimated: boolean): Promise<void> => {
  if (!isCurrent(gen)) {
    return
  }

  let next = SLOW_MS

  try {
    const pane = (await $.ui.panes()).find(one => one.id === PANE)

    if (!isCurrent(gen)) {
      return
    }

    if (!pane) {
      stopTicking()
      // Written only while no chain has started since: a reopen in the meantime wins.
      await apply($, [{ type: 'close' }], isStopped)

      return
    }

    if (!pane.isPlaced) {
      // Waiting to be seated: nothing to draw, so nothing is written — except once, when a drawn pane
      // is un-seated (a narrowed terminal), so the status line comes back while the pane is not shown.
      if ((await read($, fleet))?.isOpen === true) {
        await apply($, [{ type: 'close' }], gen)
      }

      return
    }

    const wasOpen = (await read($, fleet))?.isOpen === true
    const isDue = !wasOpen || (await $.clock.now()) - feedReadAt >= FEED_MS
    const sources = isDue ? await sourcesNow($, gen) : []
    const state = await apply($, [{ type: 'open' }, { type: 'tick' }, ...sources], gen)

    next = isMoving(state, isAnimated) ? FAST_MS : SLOW_MS
  } catch {
    // The next tick tries again.
  } finally {
    if (isCurrent(gen)) {
      arm($, gen, next, isAnimated)
    }
  }
}

/** The next tick of the chain of `gen`, `ms` from now: the one timer the chain holds; none once that chain stopped. */
const arm = ($: EngineInterface, gen: number, ms: number, isAnimated: boolean): void => {
  const chain = ticker

  if (chain?.generation !== gen) {
    return
  }

  chain.timer = $.clock.after(ms, () => {
    void tick($, gen, isAnimated)
  })
}

/** Starts a chain under the next generation unless one runs; the running chain's generation. */
const startTicking = ($: EngineInterface, isAnimated: boolean): number => {
  if (!ticker) {
    generation += 1
    ticker = { generation }
    arm($, generation, SLOW_MS, isAnimated)
  }

  return ticker.generation
}

const stopTicking = (): void => {
  ticker?.timer?.cancel()
  ticker = undefined
}

/**
 * The session's start, and every reload's: the command, the agents already
 * running (a resumed session, a hot reload), the usage so far; the tick again
 * when the pane stayed up; and, at a session's first start with `autoOpen`
 * not off, the pane asked for unasked (the engine seats it on a wide terminal).
 */
const start = async ($: EngineInterface, options: PluginOptions): Promise<void> => {
  try {
    await $.command.register({
      name: 'omelette-fleet',
      description: 'Show the fleet: agents, units and who is calling whom',
      argumentHint: '[close]',
      immediate: true,
    })
  } catch {
    // The pane still draws; the command is missing until the next reload.
  }

  try {
    const isFresh = await read($, fleet).then(
      value => value === undefined,
      () => false,
    )
    const agents = await $.agent.list().catch(() => [])
    const usage = await $.session.usage().catch(() => undefined)

    await apply($, [agentsEvent(agents), ...(usage ? [{ type: 'usage', usage: usageOf(usage) }] : [])])

    const panes = await $.ui.panes().catch(() => [])

    if (panes.some(one => one.id === PANE)) {
      startTicking($, options.animate !== false)
    } else if (isFresh && options.autoOpen !== false) {
      // Not awaited: the engine seats an unasked pane only on a wide terminal, and a `-p` run never answers.
      void $.ui.open({ id: PANE, title: TITLE }).then(
        async opened => {
          opens += 1
          const gen = startTicking($, options.animate !== false)

          if (opened.isPlaced) {
            await markOpen($, gen)
          }
        },
        () => undefined,
      )
    }
  } catch {
    // The model fills in from the events that follow.
  }
}

/**
 * What a loop's model request says: the model and effort it names, written
 * only when they change (or the request resumes a reported agent); and, when
 * the loop still holds open calls, that they are over (a loop asks the model
 * again only once its tool results are back). Nothing to change, no write.
 */
const noteStep = async ($: EngineInterface, agentId: string, model: string, effort: string | undefined): Promise<void> => {
  try {
    const state = await read($, fleet)
    const node = state?.nodes.find(one => one.id === agentId)

    if (state && !node) {
      return
    }

    const isStepped = node !== undefined && node.model === model && node.effort === effort && node.status !== 'reported'
    const events: ModelEvent[] = [...(node?.loopCalls || node?.activity !== undefined ? [{ type: 'settle', agentId }] : []), ...(isStepped ? [] : [{ type: 'step', agentId, model, effort }])]

    // With no pane ticking, the status line still names the running agents: the orchestrator's own model
    // requests refresh the engine's list (at most every 5 s), so an agent that never stops does not linger.
    if (agentId === MAIN && state && !state.isOpen && state.nodes.some(one => one.kind === 'agent' && one.status === 'running')) {
      const at = await $.clock.now()

      if (at - agentsReadAt >= AGENTS_MS) {
        agentsReadAt = at

        const agents = await $.agent.list().catch(() => undefined)

        if (agents) {
          events.push(agentsEvent(agents))
        }
      }
    }

    if (events.length > 0) {
      await apply($, events)
    }
  } catch {
    // Bookkeeping only: the request goes on.
  }
}

/** Shows `text` as a toast; a toast that cannot be shown changes nothing. */
const toast = ($: EngineInterface, text: string): void => {
  try {
    $.ui.toast(text)
  } catch {
    // The event goes on either way.
  }
}

/**
 * CLAUDE_CODE_EFFORT_LEVEL beats every agent definition's `effort:` (rules,
 * "Spawning sub-agents"): set (and not blank), the session is told at its
 * start. Never throws.
 */
const noticeEffortLevel = async ($: EngineInterface): Promise<void> => {
  try {
    const level = (await $.env.get('CLAUDE_CODE_EFFORT_LEVEL'))?.trim()

    if (level) {
      toast($, `CLAUDE_CODE_EFFORT_LEVEL=${level} is set: it overrides every agent definition's effort (rules, "Spawning sub-agents")`)
    }
  } catch {
    // No notice: the session starts as it would.
  }
}

/**
 * The pin of a spawn, or none: a guarded role asked for by a model its
 * definition does not name (roles.mjs, namesModel) runs on the definition's.
 * None with no model asked for, no definition read, or a definition naming
 * no model; none for a fork (it inherits, its model ignored) or a resume (a
 * changed content key is ignored: `resume`, in the d.ts since 2.1.312). A
 * workflow agent is pinned (the d.ts: its `model` rewrite applies), and so is
 * a teammate (nothing says its `model` rewrite is dropped). The pin is asked
 * for here; whether it took is the engine's answer (the `agent.spawn` hook).
 */
const pinOf = async (e: { subagentType: string; model?: string; fork?: boolean; resume?: unknown }): Promise<{ from: string; to: string } | undefined> => {
  if (!e.model || e.fork || e.resume !== undefined) {
    return undefined
  }

  const to = (await definitions)?.get(e.subagentType)?.model

  return to !== undefined && !namesModel(e.model, to) ? { from: e.model, to } : undefined
}

/**
 * A guarded role's step on an effort its definition does not say: one toast
 * and the row's flag, once per agent. Nothing is changed: the engine honours
 * the definition's `effort:`, and CLAUDE_CODE_EFFORT_LEVEL beats it; the flag
 * makes the exception visible. The role is the pane's (none for an agent it
 * never saw). Never throws.
 */
const flagEffort = async ($: EngineInterface, agentId: string | undefined, effort: unknown): Promise<void> => {
  if (agentId === undefined || effort === undefined || flagged.has(agentId)) {
    return
  }

  try {
    const roles = await definitions
    const state = roles?.size ? await read($, fleet) : undefined
    const role = state ? roleOf(state, agentId) : undefined
    const expected = role === undefined ? undefined : roles?.get(role)?.effort
    const actual = String(effort)

    if (expected === undefined || actual === expected) {
      return
    }

    flagged.add(agentId)

    if (state?.nodes.find(one => one.id === agentId)?.effortFlag === undefined) {
      toast($, `effort ${actual} on ${role} (definition says ${expected})`)
      await apply($, [{ type: 'effort-flag', agentId, effort: actual, expected }])
    }
  } catch {
    // Bookkeeping only: the request goes on.
  }
}

/**
 * The rendered guard's refusal of this call, or none: no script, no `node`,
 * an exit other than 2 or a run past the clock let it go on. The directory
 * is `$.session.cwd()`, "the directory the session runs in"; the 2.1.312 and
 * 2.1.316 declarations add that a value read inside the hook is the hook's
 * ("a subagent's own"), which no live run has confirmed yet. The role is the
 * pane's (none on the main loop, or for an agent the pane never saw).
 */
const guardRefusal = async ($: EngineInterface, e: { tool: unknown; agentId?: string; [key: string]: unknown }): Promise<string | undefined> => {
  const cwd = await $.session.cwd().catch(() => undefined)
  const script = await findGuardScript($, cwd)

  if (!script) {
    return undefined
  }

  const state = e.agentId === undefined ? undefined : await read($, fleet).catch(() => undefined)
  const role = state && e.agentId !== undefined ? roleOf(state, e.agentId) : undefined

  return (await askGuard($, script, toPreToolUse(e, role, cwd))).deny
}

/** The line of the touched record the guard's SubagentStop wrote for this agent, or none when there is no record to read. */
const touchedOf = async ($: EngineInterface, e: { agent_type: string; agent_id: string; cwd: string }): Promise<string | undefined> => {
  const path = touchedPath(e.agent_type, e.agent_id)

  if (!path || !e.cwd) {
    return undefined
  }

  return touchedLine(path, await $.fs.read(`${e.cwd.replace(/\/+$/, '')}/${path}`))
}

/**
 * The rendered guard's handoff print, for the prompt.context block: '' with no
 * rendered script or nothing printed. The directory is `$.session.cwd()`:
 * prompt.context's input carries none.
 */
const handoffText = async ($: EngineInterface): Promise<string> => {
  const cwd = await $.session.cwd().catch(() => undefined)
  const script = await findGuardScript($, cwd)

  return script ? printHandoff($, script, cwd) : ''
}

/**
 * The handoff gate's skip for a compaction it covers, or none (the compaction
 * goes on): a skip while no skip of the last GATE_PASS_MS stands and the
 * newest open ledger has no fresh handoff (handoff.mjs); the skip's time is
 * written first, so the next compaction within GATE_PASS_MS passes. No open
 * ledger, none.
 */
const gateSkip = async ($: EngineInterface): Promise<string | undefined> => {
  const now = await $.clock.now()
  const { value: skippedAt } = await $.state.get(handoffSkip)

  if (typeof skippedAt === 'number' && now - skippedAt <= GATE_PASS_MS) {
    return undefined
  }

  const ledger = await newestOpenLedger($, await $.session.cwd())

  if (ledger === undefined || lastHandoffFresh(ledger.text, now)) {
    return undefined
  }

  await $.state.set(handoffSkip, now)

  return GATE_SKIP
}

/** The text style of a tone; none in the ASCII form, where liveness is the ▶ alone. */
const styleOf = (tone: Tone, isAscii: boolean): { color?: string; bold?: boolean; dimColor?: boolean } => {
  if (isAscii || tone === 'plain') {
    return {}
  }

  return tone === 'live' ? { color: 'claude', bold: true } : { dimColor: true }
}

/** `Date.prototype.getTimezoneOffset` at `at`: each history time in the zone it fell in. */
const tzOffsetAt = (at: number): number => {
  try {
    return new Date(at).getTimezoneOffset()
  } catch {
    return 0
  }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    // Not awaited: a spawn waits for the definitions, the session's start does not.
    definitions = readRoleDefinitions($, e.cwd).catch(() => new Map())
    await start($, options)
    await noticeEffortLevel($)

    return next(e)
  })

  // Answers its own command: one line of text, never `next`.
  on('command.run', { command: 'omelette-fleet' }, async ($, e) => {
    if (e.args.trim() === 'close') {
      await $.ui.close({ id: PANE })

      return { text: 'Fleet pane closed.' }
    }

    const opened = await $.ui.open({ id: PANE, title: TITLE })
    opens += 1
    const gen = startTicking($, options.animate !== false)

    if (opened.isPlaced) {
      await markOpen($, gen)
    }

    return { text: opened.isPlaced ? 'Fleet pane opened.' : `Fleet pane waits: ${opened.reason}` }
  }).catch(() => ({ text: 'Fleet pane: the command failed (the debug log says why).' }))

  // The pin rewrites the spawn before the engine resolves its model, and took only when the engine's answer names
  // the definition's model: a session that forces one subagent model outranks a hook's (the d.ts, AgentSpawnInput's
  // `model`), said once in a toast and never counted; an answer with no model is not taken either, and says nothing.
  // The bookkeeping follows the engine's answer.
  on('agent.spawn', async ($, e, next) => {
    const pin = await pinOf(e).catch(() => undefined)
    const result = await next(pin ? { ...e, model: pin.to } : e)

    if (result.deny === undefined) {
      const took = pin !== undefined && namesModel(result.model, pin.to)

      if (took) {
        toast($, `pinned ${e.subagentType} to ${pin.to}`)
      } else if (pin && typeof result.model === 'string' && result.model) {
        toast($, `${e.subagentType} runs on ${result.model}: the session's forced subagent model outranks the definition's ${pin.to}`)
      }

      const spawned: ModelEvent[] = result.agentId === undefined ? [] : [{ type: 'spawn', agentId: result.agentId, role: e.subagentType, parentId: e.parentAgentId, model: result.model }]
      const pinned: ModelEvent[] = took ? [{ type: 'pinned', agentId: result.agentId, from: pin.from, to: pin.to }] : []

      if (spawned.length + pinned.length > 0) {
        await apply($, [...spawned, ...pinned])
      }
    }

    return result
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    await noteStep($, e.agentId ?? MAIN, e.model, e.effort === undefined ? undefined : String(e.effort))
    await flagEffort($, e.agentId, e.effort)

    return yield* next(e)
  })

  // Guard v2, on the tools the guard reads: registered before the bookkeeping hook, so it runs first; a refusal is
  // drawn here, as the call never goes on.
  on('tool.call', { tool: ['Bash', 'Write', 'Edit', 'NotebookEdit'] }, async ($, e, next) => {
    const deny = await guardRefusal($, e).catch(() => undefined)

    if (deny === undefined) {
      return next(e)
    }

    await apply($, [{ type: 'refused', agentId: e.agentId ?? MAIN, callId: e.tool_use_id, by: 'mod' }])

    return { deny }
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId ?? MAIN
    const callId = e.tool_use_id

    try {
      const tool = String(e.tool)
      const target = e.tool === 'SendMessage' && typeof e.to === 'string' ? e.to : undefined

      await apply($, [{ type: 'call', agentId, callId, tool, subject: subjectOf(tool, e), target }])
    } catch {
      // Bookkeeping only: the call goes on.
    }

    try {
      return await next(e)
    } finally {
      await apply($, [{ type: 'return', agentId, callId }])
    }
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)

    // A hook beneath that blocks the stop keeps the agent running. The settings hook beneath has written the touched record by now.
    if (!result?.block) {
      const touched = await touchedOf($, e).catch(() => undefined)

      await apply($, [{ type: 'stop', agentId: e.agent_id, ...(touched === undefined ? {} : { touched }) }])
    }

    return result
  }).catch(($, e, next) => next(e))

  // The handoff's one copy: the rendered guard's print as a block of the context the conversation carries, at every
  // fire (a session's first request, and again when a compaction or a /clear has it read anew).
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const text = await handoffText($).catch(() => '')

    return text ? { ...result, blocks: [...result.blocks, { name: 'omeletteHandoff', text }] } : result
  }).catch(($, e, next) => next(e))

  // Way B: on the two sources the guard prints on, its entry (the one its marker leads) leaves SessionStart's context,
  // and only while a rendered script is there for prompt.context to print from. Every other entry stays as it came.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source !== 'compact' && e.source !== 'clear') {
      return next(e)
    }

    const script = await findGuardScript($, e.cwd).catch(() => undefined)

    if (!script) {
      return next(e)
    }

    const result = await next(e)

    if (!result.additionalContext) {
      return result
    }

    const { additionalContext, ...rest } = result
    const kept = additionalContext.filter(entry => !entry.startsWith(HANDOFF_MARKER))

    // Nothing left: the key goes, never `additionalContext: undefined`.
    return kept.length > 0 ? { ...rest, additionalContext: kept } : rest
  }).catch(($, e, next) => next(e))

  // The handoff gate, off by default: a manual or automatic compaction of the main conversation is skipped once while
  // the newest open ledger has no handoff of the last 30 minutes. A sub-agent's own, a plugin's and a precompute pass.
  on('session.compact', async ($, e, next) => {
    if (options.handoffGate !== true || (e.trigger !== 'manual' && e.trigger !== 'auto') || e.agentId !== undefined) {
      return next(e)
    }

    const skip = await gateSkip($).catch(() => undefined)

    return skip === undefined ? next(e) : { skip }
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await apply($, [{ type: 'usage', usage: usageOf(e) }])

    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const opensBefore = opens
    const result = await next(e)
    // The engine's list says whether the pane closed: a hook beneath may keep it by answering without next.
    const isClosed = await $.ui.panes().then(
      panes => !panes.some(one => one.id === PANE),
      () => false,
    )

    // A reopen while the engine answered (it may keep the same chain): this close is not the pane's any more.
    if (isClosed && opens === opensBefore) {
      stopTicking()
      await apply($, [{ type: 'close' }], isStopped)
    }

    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    drawnOn = e.surface
    const state = (await read($, fleet)) ?? initialState(await $.clock.now())
    const columns = e.props.bodyColumns
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24

    // The desktop, VS Code and mobile draw the graph as one Svg, between the header and the history as text.
    if (e.surface !== 'terminal') {
      const { Box, Svg, Text } = $.ui.resolve(e)
      const drawing = svgOf(state, { tzOffsetAt, animate: options.animate !== false })
      const header = headerRow(state, { columns }).map(segment => segment.text).join('')
      // How tall the Svg is in rows is the surface's to say: the history gets the pane's rows, at least three.
      const history = historyRows(state, { columns, count: Math.max(3, bodyRows), tzOffsetAt })

      return (
        <Box flexDirection="column">
          {header ? <Text wrap="truncate-end">{header}</Text> : null}
          <Svg source={drawing.source} alt={drawing.alt} width={drawing.width} />
          {history.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {history.map(row => (
                <Text wrap="truncate-end">{row.map(segment => segment.text).join('')}</Text>
              ))}
            </Box>
          ) : null}
        </Box>
      )
    }

    const { Box, Text } = $.ui.resolve(e)
    const isAscii = Boolean(await $.env.get('NO_COLOR')) || (await $.env.get('TERM')) === 'dumb'
    const rows = layout(state, { columns, rows: bodyRows, isAscii, tzOffsetAt, animate: options.animate !== false })

    return (
      <Box flexDirection="column">
        {rows.map(row => (
          <Text wrap="truncate-end">
            {row.length === 0 ? ' ' : row.map(segment => <Text {...styleOf(segment.tone, isAscii)}>{segment.text}</Text>)}
          </Text>
        ))}
      </Box>
    )
  })
}
