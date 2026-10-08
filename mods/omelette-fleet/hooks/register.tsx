/**
 * omelette-fleet :: mods/omelette-fleet/hooks/register.tsx
 * The fleet pane's hooks module (1.7.0): the one file of the mod that calls
 * `$` and draws. Each hook turns an engine event into a fleet-model event
 * (model.mjs), writes the state, and hands the engine's own result back as it
 * received it; the render hook draws layout.mjs's rows. The mod observes: it
 * never refuses, rewrites or blocks, and a failure of its own bookkeeping
 * never reaches an event (every state write goes through `apply`, which
 * cannot throw).
 *
 * `$` is always spelled `$.noun.method(...)` literally: the engine scans this
 * source and refuses a call it did not see.
 */
import { read, update } from 'claude-code'
import type { EngineInterface, FsEntry, PluginOptions, Register, SessionUsage, Timer } from 'claude-code'

import type { FleetState } from '../types'
import { parseSnapshot, snapshotNames } from './feed.mjs'
import { layout, statusLine } from './layout.mjs'
import { initialState, MAIN, reduce } from './model.mjs'
import { subjectOf } from './text.mjs'

const PANE = 'omelette-fleet'
const TITLE = 'Fleet'
const fleet = { plugin: 'omelette-fleet', key: 'fleet' } as const

/** The pane's tick: every second while it is open; the status feed is read when the pane is drawn, then every second tick. */
const TICK_MS = 1000

/** A fleet-model event before its time is stamped (model.mjs, FleetEvent). */
type ModelEvent = { readonly type: string; readonly [field: string]: unknown }
type Tone = 'plain' | 'live' | 'dim'

/**
 * The one timer, and whether a tick is in flight. Module variables hold the
 * tick's own state only: a reload drops both, and `session.start` starts the
 * tick again.
 */
let ticker: Timer | undefined
let isTicking = false

/**
 * Applies model events at the engine's time in one state write (`update`
 * retries on a concurrent write), then sets the status line: the running
 * actors while the pane is closed, nothing while it is open. Never throws.
 */
const apply = async ($: EngineInterface, events: readonly ModelEvent[]): Promise<FleetState | undefined> => {
  try {
    const at = await $.clock.now()
    const state: FleetState = await update($, fleet, value =>
      events.reduce((acc: FleetState, event) => reduce(acc, { ...event, at }), value ?? initialState(at)),
    )

    $.ui.status(state.isOpen ? undefined : statusLine(state, at))

    return state
  } catch {
    return undefined
  }
}

/** The engine's usage figures as the model keeps them; a figure the engine does not have is left out. */
const usageOf = (usage: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>): Record<string, number> => {
  const figures: Record<string, number | undefined> = {
    contextPercent: usage.context?.percent,
    fiveHour: usage.rateLimits?.find(limit => limit.kind === 'five_hour')?.percentUsed,
    sevenDay: usage.rateLimits?.find(limit => limit.kind === 'seven_day')?.percentUsed,
    costUsd: usage.cost?.usd,
  }

  return Object.fromEntries(Object.entries(figures).filter(([, value]) => typeof value === 'number')) as Record<string, number>
}

/** The fleet home: `$OMELETTE_HOME`, else `~/.omelette`. */
const fleetHome = async ($: EngineInterface): Promise<string | undefined> => {
  const own = await $.env.get('OMELETTE_HOME')

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

/** The pane is drawn: the model knows it, its clock moves, and the status feed is read now, not at the second tick. Never throws. */
const markOpen = async ($: EngineInterface): Promise<void> => {
  const snapshots = await readFeed($).catch(() => undefined)

  await apply($, [{ type: 'open' }, { type: 'tick' }, ...(snapshots ? [{ type: 'feed', snapshots }] : [])])
}

/**
 * One tick: whether the pane is still open and drawn (a pane opened unasked on
 * a narrow terminal waits undrawn, and is seated later without an event), the
 * model's clock, and the status feed every second tick, or at once when the
 * pane has just been drawn. A tick that starts while the last one runs (a slow
 * feed read) is skipped, not queued. Never throws.
 */
const tick = async ($: EngineInterface, withFeed: boolean): Promise<void> => {
  if (isTicking) {
    return
  }

  isTicking = true

  try {
    const pane = (await $.ui.panes()).find(one => one.id === PANE)

    if (!pane) {
      stopTicking()
      await apply($, [{ type: 'close' }])

      return
    }

    const wasOpen = (await read($, fleet))?.isOpen === true
    const snapshots = pane.isPlaced && (withFeed || !wasOpen) ? await readFeed($) : undefined

    await apply($, [{ type: pane.isPlaced ? 'open' : 'close' }, { type: 'tick' }, ...(snapshots ? [{ type: 'feed', snapshots }] : [])])
  } catch {
    // The next tick tries again.
  } finally {
    isTicking = false
  }
}

/** Starts the tick unless it runs. */
const startTicking = ($: EngineInterface): void => {
  if (ticker) {
    return
  }

  let count = 0

  ticker = $.clock.every(TICK_MS, () => {
    count += 1
    void tick($, count % 2 === 0)
  })
}

const stopTicking = (): void => {
  ticker?.cancel()
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

    await apply($, [
      { type: 'agents', list: agents.map(agent => ({ id: agent.id, type: agent.type, status: agent.status, parentId: agent.parentId })) },
      ...(usage ? [{ type: 'usage', usage: usageOf(usage) }] : []),
    ])

    const panes = await $.ui.panes().catch(() => [])

    if (panes.some(one => one.id === PANE)) {
      startTicking($)
    } else if (isFresh && options.autoOpen !== false) {
      // Not awaited: the engine seats an unasked pane only on a wide terminal, and a `-p` run never answers.
      void $.ui.open({ id: PANE, title: TITLE }).then(
        async opened => {
          startTicking($)

          if (opened.isPlaced) {
            await markOpen($)
          }
        },
        () => undefined,
      )
    }
  } catch {
    // The model fills in from the events that follow.
  }
}

/** What a loop's model request names, written only when it changes (or resumes a reported agent). */
const noteStep = async ($: EngineInterface, agentId: string, model: string, effort: string | undefined): Promise<void> => {
  try {
    const state = await read($, fleet)
    const node = state?.nodes.find(one => one.id === agentId)

    if (state && (!node || (node.model === model && node.effort === effort && node.status !== 'reported'))) {
      return
    }

    await apply($, [{ type: 'step', agentId, model, effort }])
  } catch {
    // Bookkeeping only: the request goes on.
  }
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
    await start($, options)

    return next(e)
  })

  // Answers its own command: one line of text, never `next`.
  on('command.run', { command: 'omelette-fleet' }, async ($, e) => {
    if (e.args.trim() === 'close') {
      await $.ui.close({ id: PANE })

      return { text: 'Fleet pane closed.' }
    }

    const opened = await $.ui.open({ id: PANE, title: TITLE })

    startTicking($)

    if (opened.isPlaced) {
      await markOpen($)
    }

    return { text: opened.isPlaced ? 'Fleet pane opened.' : `Fleet pane waits: ${opened.reason}` }
  }).catch(() => ({ text: 'Fleet pane: the command failed (the debug log says why).' }))

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)

    if (result.deny === undefined && result.agentId !== undefined) {
      await apply($, [{ type: 'spawn', agentId: result.agentId, role: e.subagentType, parentId: e.parentAgentId, model: result.model }])
    }

    return result
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    await noteStep($, e.agentId ?? MAIN, e.model, e.effort === undefined ? undefined : String(e.effort))

    return yield* next(e)
  })

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

    // A hook beneath that blocks the stop keeps the agent running.
    if (!result?.block) {
      await apply($, [{ type: 'stop', agentId: e.agent_id }])
    }

    return result
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await apply($, [{ type: 'usage', usage: usageOf(e) }])

    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)

    if (!(result && 'deny' in result && result.deny)) {
      stopTicking()
      await apply($, [{ type: 'close' }])
    }

    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const state = (await read($, fleet)) ?? initialState(await $.clock.now())
    const isAscii = Boolean(await $.env.get('NO_COLOR')) || (await $.env.get('TERM')) === 'dumb'
    const rows = layout(state, {
      columns: e.props.bodyColumns,
      rows: e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24,
      isAscii,
      tzOffsetAt,
    })

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
