/**
 * omelette-fleet :: mods/omelette-fleet/tests/tester-t3.test.ts
 * Tester's kit tests for 1.7.0 Task 3 (run by `claude plugin test`, never by `npm test`): the live
 * module against the engine, from the plan's Task 3 and the rulings. Paths and ids are made up.
 */
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderInput, SessionStartInput } from 'claude-code'

import type { FleetState } from '../types'

const PLUGIN = 'omelette-fleet'
const NOW = Date.UTC(2026, 9, 8, 9, 0, 0)
const SESSION: SessionStartInput = { cwd: '/home/op/work', surface: 'terminal', isInteractive: true }
const HOME = '/home/op'

type World = {
  fleet: FleetState | undefined
  writes: number
  opened: string[]
  closed: string[]
  statuses: (string | undefined)[]
  panes: { id: string; isPlaced: boolean }[]
}

/** The engine beneath the plugin, in memory. `placed` is whether `ui.open` seats the pane. */
function worldOf(on: On, { placed = true, denyClose = false, panes = [] }: { placed?: boolean; denyClose?: boolean; panes?: { id: string; isPlaced: boolean }[] } = {}): World {
  const world: World = { fleet: undefined, writes: 0, opened: [], closed: [], statuses: [], panes: [...panes] }

  on('state.set', ($, e, next) => {
    if (e.plugin === PLUGIN && e.key === 'fleet') {
      world.fleet = e.value as FleetState
      world.writes += 1
    }

    return next(e)
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1_000_000, percent: 31 }, rateLimits: [], cost: { usd: 3 } } }))
  on('ui.open', ($, e) => {
    world.opened.push(e.id)

    if (!world.panes.some(pane => pane.id === e.id)) {
      world.panes.push({ id: e.id, isPlaced: placed })
    }

    return { value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'the terminal is too narrow (90 columns, the floor is 144)' } } as never
  })
  on('ui.close', ($, e) => {
    world.closed.push(e.id)

    if (denyClose) {
      return { deny: 'the person keeps it open' } as never
    }

    world.panes = world.panes.filter(pane => pane.id !== e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({ value: world.panes.map(pane => ({ ...pane, title: 'Fleet', isShown: true, isFocused: false })) }))
  on('ui.status', ($, e) => {
    world.statuses.push(e.text)

    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  return world
}

const command = (args = '') => ({ command: 'omelette-fleet', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 180 } })

const PANE: RenderInput<'Pane'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: 'omelette-fleet',
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: { title: 'Fleet', isFocused: false, bodyColumns: 53, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}

const SPAWN = {
  tool_use_id: 'toolu_spawn1',
  prompt: 'Run the suite',
  description: 'Run the suite',
  subagentType: 'omelette-coder-medium',
  provider: { plugin: 'project', tier: 'user' },
  parentModel: 'claude-fable-5-1',
  background: false,
  fork: false,
}
const SPAWNED = { model: 'claude-opus-5-5', agentId: 'agent-c1' }
const STEPPED = { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
const BASH_RESULT = { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }
const UNIT_RESULT = { result: { content: [{ type: 'text', text: 'two findings' }] }, text: 'two findings' }
const STOP = { agent_id: 'agent-c1', agent_type: 'omelette-coder-medium', agent_transcript_path: '', stop_hook_active: false }

/** Raises one request in a loop, reads its stream to the end; the chunks it yielded and what it returned. */
async function step($: unknown, agentId: string | undefined, model: string, effort: string | number | undefined) {
  const engine = $ as { turn: { step: (e: never) => AsyncGenerator<unknown, unknown> } }
  const stream = engine.turn.step({ turnId: 't1', index: 0, model, effort, messageCount: 3, ...(agentId && { agentId }) } as never)
  const chunks: unknown[] = []
  let read = await stream.next()

  while (!read.done) {
    chunks.push(read.value)
    read = await stream.next()
  }

  return { chunks, value: read.value }
}

const nodeOf = (world: World, id: string) => world.fleet?.nodes.find(node => node.id === id)
const linksOf = (world: World) => (world.fleet?.history ?? []).map(link => `${link.from} > ${link.to} · ${link.label}`)

describe('the data sources', () => {
  test('a spawn, a step with a numeric effort, a tool call and a stop: the agent is reported with its model and three history links', async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    on('turn.step', async function* () {
      return STEPPED
    })
    on('tool.call', () => UNIT_RESULT)
    on('classic.SubagentStop', () => ({}))
    await $.session.start(SESSION)

    await $.agent.spawn(SPAWN as never)
    await step($, 'agent-c1', 'claude-sonnet-5-5', 3)
    expect(nodeOf(world, 'agent-c1')).toMatchObject({ status: 'running', model: 'claude-sonnet-5-5', effort: '3' })
    await $.tool.call({ tool: 'mcp__orion-codex__codex_code_review', prompt: 'review', cwd: '/home/op/work', agentId: 'agent-c1' } as never)
    await $.classic.SubagentStop(STOP as never)

    expect(nodeOf(world, 'agent-c1')).toMatchObject({ kind: 'agent', status: 'reported', model: 'claude-sonnet-5-5', effort: '3' })
    expect(linksOf(world)).toEqual(['main > agent-c1 · Agent', 'agent-c1 > unit:codex · code_review', 'agent-c1 > main · report'])
  })

  test('a resumed agent: stepping again after it reported, on another model, makes it running with the new model and effort', async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    on('turn.step', async function* () {
      return STEPPED
    })
    on('classic.SubagentStop', () => ({}))
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await step($, 'agent-c1', 'claude-opus-5-5', 'medium')
    await $.classic.SubagentStop(STOP as never)
    expect(nodeOf(world, 'agent-c1')?.status).toBe('reported')

    await step($, 'agent-c1', 'claude-sonnet-5-5', 'high')
    expect(nodeOf(world, 'agent-c1')).toMatchObject({ status: 'running', model: 'claude-sonnet-5-5', effort: 'high' })
  })

  test('a nested spawn (parentAgentId an agent) hangs under that agent, and its stop reports to it', async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('agent.spawn', ($$, e) => (e.subagentType === 'omelette-reviewer' ? { model: 'claude-opus-5-5', agentId: 'agent-r1' } : SPAWNED))
    on('classic.SubagentStop', () => ({}))
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-reviewer', parentAgentId: 'agent-c1' } as never)
    await $.classic.SubagentStop({ ...STOP, agent_id: 'agent-r1', agent_type: 'omelette-reviewer' } as never)

    expect(nodeOf(world, 'agent-r1')).toMatchObject({ parentId: 'agent-c1', status: 'reported' })
    expect(linksOf(world)).toEqual(['main > agent-c1 · Agent', 'agent-c1 > agent-r1 · Agent', 'agent-r1 > agent-c1 · report'])
  })

  test('a SendMessage call writes a link to its target; an unknown target stays as written', async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    on('tool.call', () => ({ result: { ok: true }, text: 'sent' }))
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.tool.call({ tool: 'SendMessage', to: 'researcher', message: 'hi', agentId: 'agent-c1', tool_use_id: 'toolu_m1' } as never)
    await $.tool.call({ tool: 'SendMessage', to: 'agent-c1', message: 'hi', tool_use_id: 'toolu_m2' } as never)

    expect(linksOf(world)).toEqual(['main > agent-c1 · Agent', 'agent-c1 > researcher · SendMessage', 'main > agent-c1 · SendMessage'])
  })

  test('a step on an unknown agent writes nothing and creates no node', async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('turn.step', async function* () {
      return STEPPED
    })
    await $.session.start(SESSION)

    const before = world.fleet?.nodes.length
    const { value } = await step($, 'agent-ghost', 'claude-opus-5-5', 'high')

    expect(value).toEqual(STEPPED)
    expect(world.fleet?.nodes.length).toBe(before)
    expect(nodeOf(world, 'agent-ghost')).toBeUndefined()
  })

  test('turn.step: the stream passes through untouched, chunk by chunk, and so does the result', async ($, on) => {
    worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('turn.step', async function* () {
      yield { kind: 'text', index: 0, text: 'one ' }
      yield { kind: 'text', index: 0, text: 'two' }

      return STEPPED
    })
    await $.session.start(SESSION)

    const { chunks, value } = await step($, undefined, 'claude-fable-5-1', 'high')

    expect(chunks).toEqual([{ kind: 'text', index: 0, text: 'one ' }, { kind: 'text', index: 0, text: 'two' }])
    expect(value).toEqual(STEPPED)
  })

  test('the main loop\'s step records model and effort once per change', async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('turn.step', async function* () {
      return STEPPED
    })
    await $.session.start(SESSION)
    await step($, undefined, 'claude-fable-5-1', 'high')
    expect(nodeOf(world, 'main')).toMatchObject({ model: 'claude-fable-5-1', effort: 'high' })

    const writes = world.writes

    await step($, undefined, 'claude-fable-5-1', 'high')
    expect(world.writes).toBe(writes)
    await step($, undefined, 'claude-fable-5-1', 'xhigh')
    expect(world.writes).toBe(writes + 1)
    expect(nodeOf(world, 'main')?.effort).toBe('xhigh')
    await step($, undefined, 'claude-fable-5-1', undefined)
    expect(nodeOf(world, 'main')?.effort, 'no effort now: the node drops it').toBeUndefined()
  })
})

describe('autoOpen and the command', () => {
  test('a reload (a second session.start in the same session) never reopens a pane the person closed', async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    await $.session.start(SESSION)
    expect(world.opened).toEqual(['omelette-fleet'])

    await $.command.run(command('close'))
    expect(world.panes).toEqual([])
    await $.session.start(SESSION)
    expect(world.opened, 'no second open').toEqual(['omelette-fleet'])
  })

  test('autoOpen false: neither the start nor a later start opens it; the command still does', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    await $.session.start(SESSION)
    await $.session.start(SESSION)
    expect(world.opened).toEqual([])
    expect(await $.command.run(command())).toEqual({ text: 'Fleet pane opened.' })
    expect(world.opened).toEqual(['omelette-fleet'])
  })

  test('the command with any argument but close opens; close with the pane not open answers one line and does not throw', async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    await $.session.start({ ...SESSION })
    world.panes = []
    world.opened = []

    const closed = await $.command.run(command('close'))

    expect(closed).toMatchObject({ text: expect.any(String) })
    expect((closed as { text: string }).text.split('\n')).toHaveLength(1)
    expect(await $.command.run(command('whatever'))).toEqual({ text: 'Fleet pane opened.' })
    expect(world.opened).toEqual(['omelette-fleet'])
  })

  test('a pane that waits undrawn (narrow terminal): the command answers one line naming why, and the model is not open', async ($, on) => {
    const world = worldOf(on, { placed: false })

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    await $.session.start(SESSION)

    const answer = (await $.command.run(command())) as { text: string }

    expect(answer.text).toMatch(/waits/)
    expect(answer.text).toMatch(/too narrow/)
    expect(answer.text.split('\n')).toHaveLength(1)
    expect(world.fleet?.isOpen).toBe(false)
  })

  test('after /omelette-fleet close the tick is cancelled: no further state writes', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })
    await $.session.start(SESSION)
    await clock.advance(1_100)
    expect(world.fleet?.isOpen).toBe(true)
    await $.command.run(command('close'))
    expect(world.fleet?.isOpen).toBe(false)

    const writes = world.writes

    await clock.advance(5_000)
    expect(world.writes, 'no tick writes after the close').toBe(writes)
  })

  test('a close the engine refuses (deny beneath) leaves the model open and the tick running', async ($, on) => {
    const world = worldOf(on, { denyClose: true })
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })
    await $.session.start(SESSION)
    await clock.advance(1_100)
    expect(world.fleet?.isOpen).toBe(true)
    await $.command.run(command('close'))
    expect(world.fleet?.isOpen, 'a refused close is not a close').toBe(true)

    const before = world.fleet?.now ?? 0

    await clock.advance(3_000)
    expect(world.fleet?.now, 'the tick still runs').toBeGreaterThan(before)
  })

  test('close is recognised with spaces round it', async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    await $.session.start(SESSION)
    expect(await $.command.run(command('  close '))).toEqual({ text: 'Fleet pane closed.' })
    expect(world.closed).toEqual(['omelette-fleet'])
  })

  test('a reload with the pane still open (a fresh module, the pane in the engine\'s list) starts the tick without opening anything', async ($, on) => {
    const world = worldOf(on, { panes: [{ id: 'omelette-fleet', isPlaced: true }] })
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })
    await $.session.start(SESSION)
    expect(world.opened).toEqual([])
    await clock.advance(2_100)
    expect(world.fleet?.now).toBeGreaterThanOrEqual(NOW + 2_000)
    expect(world.fleet?.isOpen).toBe(true)
  })

  test('while the pane is open the tick moves the model\'s clock', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })
    await $.session.start(SESSION)
    await clock.advance(3_100)
    expect(world.fleet?.now).toBeGreaterThanOrEqual(NOW + 3_000)
  })
})

describe('the mod never changes a result, and a failure in its bookkeeping never reaches one', () => {
  for (const noun of ['clock.now', 'state.get', 'state.set', 'ui.status'] as const) {
    test(`with ${noun} refused: every result is what the hook beneath returned, each beneath hook ran once`, async ($, on) => {
      const calls = { spawn: 0, tool: 0, stop: 0, step: 0, measure: 0 }

      if (noun !== 'clock.now') {
        mock.clock(on, { now: NOW })
      }

      mock.env(on, { HOME })
      on(noun as never, () => ({ deny: `${noun} refused in this test` }) as never)
      on('agent.spawn', () => {
        calls.spawn += 1

        return SPAWNED
      })
      on('tool.call', () => {
        calls.tool += 1

        return UNIT_RESULT
      })
      on('classic.SubagentStop', () => {
        calls.stop += 1

        return { block: 'not yet' }
      })
      on('turn.step', async function* () {
        calls.step += 1
        yield { kind: 'text', index: 0, text: 'hello' }

        return STEPPED
      })
      on('session.measure', ($$, e) => {
        calls.measure += 1

        return { changed: e.changed }
      })

      expect(await $.agent.spawn(SPAWN as never)).toEqual(SPAWNED)
      expect(await $.tool.call({ tool: 'mcp__orion-codex__codex_code_review', prompt: 'p', cwd: '/home/op/work', agentId: 'agent-c1' } as never)).toMatchObject(UNIT_RESULT)
      expect(await $.tool.call({ tool: 'Bash', command: 'npm test' } as never).catch(() => 'rejected')).toBeDefined()
      expect(await $.classic.SubagentStop(STOP as never)).toMatchObject({ block: 'not yet' })
      expect(await step($, 'agent-c1', 'claude-opus-5-5', 'high')).toEqual({ chunks: [{ kind: 'text', index: 0, text: 'hello' }], value: STEPPED })
      expect(await $.session.measure({ context: { window: 1_000_000, percent: 40 }, rateLimits: [], changed: ['context'] } as never)).toEqual({ changed: ['context'] })
      expect(calls.spawn).toBe(1)
      expect(calls.tool).toBeGreaterThanOrEqual(1)
      expect(calls.stop).toBe(1)
      expect(calls.step).toBe(1)
      expect(calls.measure).toBe(1)
    })
  }

  test('a hook beneath that throws in state.set is skipped by the engine and the results are untouched', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('state.set', () => {
      throw new Error('the store is broken')
    })
    on('agent.spawn', () => SPAWNED)
    on('tool.call', () => BASH_RESULT)

    expect(await $.agent.spawn(SPAWN as never)).toEqual(SPAWNED)
    expect(await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)).toMatchObject(BASH_RESULT)
  })

  test('session.measure updates the usage figures the header shows, and hands its result on', async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('session.measure', ($$, e) => ({ changed: e.changed }))
    await $.session.start(SESSION)
    expect(await $.session.measure({ context: { window: 1_000_000, percent: 44 }, rateLimits: [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 73 }], cost: { usd: 12.5 }, changed: ['context'] } as never)).toEqual({ changed: ['context'] })
    expect(world.fleet?.usage).toEqual({ contextPercent: 44, fiveHour: 12, sevenDay: 73, costUsd: 12.5 })
  })

  test('with the pane open the status line is cleared even while a unit runs; closed, it names the unit', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })

    let release: (value: unknown) => void = () => undefined

    on('tool.call', () => new Promise(resolve => (release = resolve)) as never)
    await $.session.start(SESSION)

    const call = $.tool.call({ tool: 'mcp__orion-grok__grok_code_review', prompt: 'r', cwd: '/home/op/work', tool_use_id: 'toolu_g1' } as never)

    await clock.settle()
    expect(world.fleet?.isOpen).toBe(true)
    expect(world.statuses.at(-1), 'the pane shows it, the line stays empty').toBeUndefined()
    await $.command.run(command('close'))
    expect(world.statuses.at(-1)).toMatch(/^fleet: grok /)
    release(UNIT_RESULT)
    await call
  })

  test('a blocked stop leaves the agent running and its result as the hook beneath gave it', async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    on('classic.SubagentStop', () => ({ block: 'keep going' }))
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)

    expect(await $.classic.SubagentStop(STOP as never)).toMatchObject({ block: 'keep going' })
    expect(nodeOf(world, 'agent-c1')?.status).toBe('running')
    expect(linksOf(world)).toEqual(['main > agent-c1 · Agent'])
  })

  test('a spawn that was refused (deny) adds no node', async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('agent.spawn', () => ({ deny: 'no agents today' }))
    await $.session.start(SESSION)

    expect(await $.agent.spawn(SPAWN as never)).toMatchObject({ deny: 'no agents today' })
    expect(world.fleet?.nodes.some(node => node.kind === 'agent')).toBe(false)
    expect(world.fleet?.history).toEqual([])
  })

  test('a tool call that never returns does not block the model\'s view: its activity shows while it runs and clears after', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })

    let release: (value: unknown) => void = () => undefined

    on('tool.call', () => new Promise(resolve => (release = resolve)) as never)
    await $.session.start(SESSION)

    const call = $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_b1' } as never)

    await clock.settle()
    expect(nodeOf(world, 'main')).toMatchObject({ status: 'running', activity: 'Bash: npm test' })
    release(BASH_RESULT)
    expect(await call).toMatchObject(BASH_RESULT)
    expect(nodeOf(world, 'main')?.activity).toBeUndefined()
  })

  test('a Bash command carrying a secret shows only its program: the secret reaches neither the model nor the pane', async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('tool.call', () => new Promise(() => undefined) as never)
    await $.session.start(SESSION)
    void $.tool.call({ tool: 'Bash', command: 'TOKEN=hunter2 curl -H "Authorization: Bearer hunter2" https://x', tool_use_id: 'toolu_s1' } as never)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(JSON.stringify(world.fleet)).not.toContain('hunter2')
    expect(nodeOf(world, 'main')?.activity).toBe('Bash: curl')
  })
})

describe('the pane', () => {
  const textsOf = async (pane: { findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }) => (await pane.findAll({ type: 'Text' }))
  type Node = { type?: string; children?: unknown[] }
  const flat = (item: unknown): string => (typeof item === 'string' ? item : ((item as Node).children ?? []).map(flat).join(''))
  /** The pane's rows: the children of the root Box, as text. */
  const rowsOf = async (pane: { drawn: () => Promise<unknown> }) => ((await pane.drawn()) as Node).children?.map(flat) ?? []

  for (const [name, env] of [['NO_COLOR', { HOME, NO_COLOR: '1' }], ['TERM=dumb', { HOME, TERM: 'dumb' }]] as const) {
    test(`with ${name} the form is ASCII and no Text carries any style`, async ($, on) => {
      worldOf(on)
      mock.clock(on, { now: NOW })
      mock.env(on, env)
      on('agent.spawn', () => SPAWNED)
      await $.session.start(SESSION)
      await $.agent.spawn(SPAWN as never)

      const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN })
      const texts = await textsOf(pane)

      expect(texts.some(text => text.text.includes('+---------------+')), 'ASCII frames').toBe(true)
      expect(texts.some(text => /[─│┌┐└┘●▶]/.test(text.text))).toBe(false)
      expect(texts.every(text => text.props.color === undefined && text.props.bold === undefined && text.props.dimColor === undefined)).toBe(true)
      await pane.unmount()
    })
  }

  test('normal colour: live is the accent colour and bold, dim is dimColor, plain has no style', async ($, on) => {
    worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)

    const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN })
    const texts = await textsOf(pane)
    const live = texts.filter(text => text.props.color !== undefined)
    const dim = texts.filter(text => text.props.dimColor === true)

    expect(live.length).toBeGreaterThan(0)
    expect(live.every(text => text.props.color === 'claude' && text.props.bold === true)).toBe(true)
    expect(dim.length).toBeGreaterThan(0)
    expect(live.some(text => text.text.includes('┬') || text.text.includes('┴') || text.text.includes('│'))).toBe(true)
    await pane.unmount()
  })

  test('the pane\'s rows come from scroll.bodyRows, else the viewport; no more rows than that', async ($, on) => {
    worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    await $.session.start(SESSION)

    const small = await $.ui.mount({ ...PANE, plugin: PLUGIN, props: { ...PANE.props, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4 } } })
    const tree = await rowsOf(small)

    expect(tree.length).toBe(4)
    expect(tree.at(-1)).toMatch(/… \+\d+/)
    await small.unmount()

    const viewport = await $.ui.mount({ ...PANE, plugin: PLUGIN, viewport: { columns: 180, rows: 3, isFullscreen: true }, props: { ...PANE.props, bodyColumns: 80, scroll: undefined } })

    expect((await rowsOf(viewport)).length).toBe(3)
    await viewport.unmount()
  })

  test('a pane 20 columns wide draws the tree and no Text holds more than 20 cells', async ($, on) => {
    worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    await $.session.start(SESSION)

    const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN, props: { ...PANE.props, bodyColumns: 20 } })
    const rows = await rowsOf(pane)

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(row => [...row].length <= 20)).toBe(true)
    expect(rows.some(row => /[┌┐┬┴┼]/.test(row)), 'no graph at 20 columns').toBe(false)
    await pane.unmount()
  })

  test('before any event the pane draws the initial state (the orchestrator and the three units)', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })

    const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN })

    expect(await pane.find({ type: 'Text', text: '● orchestrator' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'no feed' })).toBeDefined()
    await pane.unmount()
  })
})
