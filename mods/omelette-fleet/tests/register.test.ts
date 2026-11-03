/**
 * omelette-fleet :: mods/omelette-fleet/tests/register.test.ts
 * The live module against the engine (1.7.0, Task 3), run by `claude plugin
 * test` at the live gate, never by `npm test`: the command, the hooks of the
 * spec's data sources turning engine events into the fleet model, the pane
 * drawn on the terminal, and the mod handing every result on as it got it.
 * Paths and ids are made up.
 */
import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, On, RenderInput, SessionStartInput } from 'claude-code'

import type { FleetState } from '../types'

const PLUGIN = 'omelette-fleet'
const NOW = Date.UTC(2026, 9, 8, 9, 0, 0)
const SESSION: SessionStartInput = { cwd: '/home/op/work', surface: 'terminal', isInteractive: true }
const HOME = '/home/op'

type World = {
  /** The fleet model as the plugin last wrote it to `$.state`, and how many writes it made. */
  fleet: FleetState | undefined
  writes: number
  commands: { name: string; description?: string; immediate?: boolean }[]
  opened: string[]
  closed: string[]
  statuses: (string | undefined)[]
  panes: { id: string; isPlaced: boolean }[]
  /** How many times the fleet home was listed, and a listing held open until the test lets it go. */
  lists: number
  /** How many times the plugin asked which panes are open: once per tick. */
  asks: number
  hold: Promise<void> | undefined
  /** The next ask for the panes, held until the test lets it go, answered with what the test gives. */
  heldAsk: Promise<{ id: string; isPlaced: boolean }[]> | undefined
  /** What `$.agent.list()` answers. */
  agents: AgentInfo[]
}

type Engine = {
  /** The fleet home's files, by path. */
  files?: Readonly<Record<string, string>>
  /** Whether `ui.open` seats the pane (false: a terminal too narrow). */
  placed?: boolean
  /** Whether `ui.close` is refused beneath the plugin. */
  denyClose?: boolean
  /** Whether a hook beneath answers `ui.close` without closing the pane (no deny: the pane just stays). */
  keepOnClose?: boolean
  /** The panes the engine already holds (a reload with the pane open). */
  panes?: { id: string; isPlaced: boolean }[]
}

/** The engine beneath the plugin, in memory: what it registers, opens and shows, and the fleet home's files. */
function worldOf(on: On, { files = {}, placed = true, denyClose = false, keepOnClose = false, panes = [] }: Engine = {}): World {
  const world: World = { fleet: undefined, writes: 0, commands: [], opened: [], closed: [], statuses: [], panes: [...panes], lists: 0, hold: undefined, asks: 0, heldAsk: undefined, agents: [] }

  on('state.set', ($, e, next) => {
    if (e.plugin === PLUGIN && e.key === 'fleet') {
      world.fleet = e.value as FleetState
      world.writes += 1
    }

    return next(e)
  })

  on('command.register', ($, e) => {
    world.commands.push({ name: e.name, description: e.description, immediate: e.immediate })

    return { value: { command: e.name } }
  })
  on('agent.list', () => ({ value: world.agents }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 1_000_000, percent: 31 }, rateLimits: [{ kind: 'five_hour', percentUsed: 11 }, { kind: 'seven_day', percentUsed: 71 }], cost: { usd: 646.7 } },
  }))
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

    if (keepOnClose) {
      return { value: undefined }
    }

    world.panes = world.panes.filter(pane => pane.id !== e.id)

    return { value: undefined }
  })
  on('ui.panes', async () => {
    world.asks += 1

    const held = world.heldAsk

    world.heldAsk = undefined

    const panes = held ? await held : world.panes

    return { value: panes.map(pane => ({ ...pane, title: 'Fleet', isShown: true, isFocused: false })) }
  })
  on('ui.status', ($, e) => {
    world.statuses.push(e.text)

    return { value: undefined }
  })
  on('fs.list', async ($, e) => {
    world.lists += 1
    await world.hold
    const dir = `${e.path}/`
    const names = Object.keys(files).filter(path => path.startsWith(dir)).map(path => path.slice(dir.length))

    return { value: names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: NOW, isLink: false })) } as never
  })
  on('fs.read', ($, e) => (files[e.path] === undefined ? { deny: `ENOENT: ${e.path}` } : { value: files[e.path] }))
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
const BASH_RESULT = { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }
const UNIT_RESULT = { result: { content: [{ type: 'text', text: 'two findings' }] }, text: 'two findings' }

/** Raises one model request in a loop, reads its stream to the end and answers what it returned. */
async function step($: { turn: { step: (e: never) => AsyncGenerator<unknown, unknown> } }, agentId: string | undefined, effort: string | number) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort, messageCount: 3, ...(agentId && { agentId }) } as never)
  let read = await stream.next()

  while (!read.done) {
    read = await stream.next()
  }

  return read.value
}

const STEPPED = { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
const STOP = { agent_id: 'agent-c1', agent_type: 'omelette-coder-medium', agent_transcript_path: '', stop_hook_active: false }

const nodeOf = (world: World, id: string) => world.fleet?.nodes.find(node => node.id === id)
const linksOf = (world: World) => (world.fleet?.history ?? []).map(link => `${link.from} > ${link.to} · ${link.label}`)

/** How many times the plugin asked for the panes in the next `ms`: one ask per tick. */
async function asksIn(clock: { advance: (ms: number) => Promise<void> }, world: World, ms: number): Promise<number> {
  const before = world.asks

  await clock.advance(ms)

  return world.asks - before
}

describe('the session start and the command', () => {
  test('the start registers /omelette-fleet, mid-turn, and opens the pane unasked (autoOpen left out: its default)', async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    await $.session.start(SESSION)

    expect(world.commands).toEqual([{ name: 'omelette-fleet', description: 'Show the fleet: agents, units and who is calling whom', immediate: true }])
    expect(world.opened).toEqual(['omelette-fleet'])

    const state = world.fleet

    expect(state?.nodes.map(node => node.id)).toEqual(['main', 'unit:gemini', 'unit:grok', 'unit:codex'])
    expect(state?.usage, 'the cost is not kept: the pane draws none').toEqual({ contextPercent: 31, fiveHour: 11, sevenDay: 71 })
  })

  test('an unset autoOpen reaches the plugin as its default: the pane opens', { options: {} }, async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    await $.session.start(SESSION)

    expect(world.opened).toEqual(['omelette-fleet'])
  })

  test('autoOpen off: nothing opens unasked, the command still opens it', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    await $.session.start(SESSION)

    expect(world.opened).toEqual([])
    expect(await $.command.run(command())).toEqual({ text: 'Fleet pane opened.' })
    expect(world.opened).toEqual(['omelette-fleet'])
    expect(world.fleet?.isOpen).toBe(true)
  })

  test('/omelette-fleet close closes the pane and the model knows it at once', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    await $.session.start(SESSION)
    await $.command.run(command())

    expect(await $.command.run(command('close'))).toEqual({ text: 'Fleet pane closed.' })
    expect(world.closed).toEqual(['omelette-fleet'])
    expect(world.fleet?.isOpen).toBe(false)
  })

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

  test('close is recognised with spaces round it', async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    await $.session.start(SESSION)
    expect(await $.command.run(command('  close '))).toEqual({ text: 'Fleet pane closed.' })
    expect(world.closed).toEqual(['omelette-fleet'])
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

  test('a close a hook beneath answers without closing the pane (no deny) keeps the model open and the tick running', async ($, on) => {
    const world = worldOf(on, { keepOnClose: true })
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })
    await $.session.start(SESSION)
    await clock.advance(1_100)
    await $.command.run(command('close'))
    expect(world.panes.map(pane => pane.id), 'the engine still holds it').toEqual(['omelette-fleet'])
    expect(world.fleet?.isOpen, 'a close that left the pane is not a close').toBe(true)

    const before = world.fleet?.now ?? 0

    await clock.advance(3_000)
    expect(world.fleet?.now, 'the tick still runs').toBeGreaterThan(before)
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
})

describe('the hooks of the data sources', () => {
  test('a spawn, a step, a unit call and a stop: the agent reported, its model and effort set, three history links', async ($, on) => {
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
    await step($ as never, 'agent-c1', 'medium')
    await $.tool.call({ tool: 'mcp__orion-grok__grok_code_review', prompt: 'review', cwd: '/home/op/work', agentId: 'agent-c1' } as never)
    await $.classic.SubagentStop({ agent_id: 'agent-c1', agent_type: 'omelette-coder-medium', agent_transcript_path: '', stop_hook_active: false } as never)

    const state = world.fleet
    const agent = state?.nodes.find(node => node.id === 'agent-c1')

    expect(agent).toMatchObject({ kind: 'agent', role: 'omelette-coder-medium', parentId: 'main', model: 'claude-opus-5-5', effort: 'medium', status: 'reported' })
    expect(state?.history.map(link => `${link.from} > ${link.to} · ${link.label}`)).toEqual([
      'main > agent-c1 · Agent',
      'agent-c1 > unit:grok · code_review',
      'agent-c1 > main · report',
    ])
    expect(state?.nodes.find(node => node.id === 'unit:grok')?.status, 'the call returned').toBe('idle')
  })

  test('a reported agent that steps again on the same model and effort is running again (resumed)', async ($, on) => {
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
    await step($ as never, 'agent-c1', 'medium')
    await $.classic.SubagentStop({ agent_id: 'agent-c1', agent_type: 'omelette-coder-medium', agent_transcript_path: '', stop_hook_active: false } as never)
    expect(world.fleet?.nodes.find(node => node.id === 'agent-c1')?.status).toBe('reported')

    await step($ as never, 'agent-c1', 'medium')
    expect(world.fleet?.nodes.find(node => node.id === 'agent-c1')?.status).toBe('running')
  })

  test('a step on an unchanged model writes nothing; a numeric effort is kept as text', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('turn.step', async function* () {
      return STEPPED
    })
    await $.session.start(SESSION)
    // The unasked open runs unawaited: its write lands before the writes are counted.
    await clock.settle()

    await step($ as never, undefined, 'high')
    expect(world.fleet?.nodes.find(node => node.id === 'main')).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })

    const writes = world.writes

    await step($ as never, undefined, 'high')
    expect(world.writes, 'the same model and effort again: no write').toBe(writes)

    await step($ as never, undefined, 3)
    expect(world.fleet?.nodes.find(node => node.id === 'main')?.effort).toBe('3')
  })

  test('a call whose return never comes is cleared at its loop\'s next step, in one write; a step after that writes nothing', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })
    let release: (value: unknown) => void = () => undefined

    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    on('turn.step', async function* () {
      return STEPPED
    })
    on('tool.call', () => new Promise(resolve => (release = resolve)) as never)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await step($ as never, 'agent-c1', 'medium')

    const lost = $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'agent-c1', tool_use_id: 'toolu_lost' } as never)

    await clock.settle()
    expect(nodeOf(world, 'agent-c1')?.activity).toBe('Bash: npm test')

    const writes = world.writes

    await step($ as never, 'agent-c1', 'medium')
    expect(nodeOf(world, 'agent-c1')?.activity, 'the call is over').toBeUndefined()
    expect(nodeOf(world, 'agent-c1')?.loopCalls).toBeUndefined()
    expect(nodeOf(world, 'agent-c1')?.status).toBe('running')
    expect(world.writes, 'one write').toBe(writes + 1)

    await step($ as never, 'agent-c1', 'medium')
    expect(world.writes, 'nothing open, nothing changed: no write').toBe(writes + 1)

    release(BASH_RESULT)
    await lost
  })

  test('while the pane is closed the status line names what runs, and clears when nothing does', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })

    let release: (value: unknown) => void = () => undefined

    on('tool.call', () => new Promise(resolve => (release = resolve)) as never)
    await $.session.start(SESSION)

    const call = $.tool.call({ tool: 'mcp__orion-grok__grok_code_review', prompt: 'review', cwd: '/home/op/work' } as never)

    await clock.settle()
    expect(world.statuses.at(-1)).toBe('fleet: grok 0:00')

    release(UNIT_RESULT)
    await call
    expect(world.statuses.at(-1)).toBeUndefined()
  })

  test('with the pane open the tick reads the status feed: a unit with a snapshot has a feed', async ($, on) => {
    const world = worldOf(on, { files: {
      '/home/op/.omelette/status-codex-4242.json': JSON.stringify({ schema: 2, unit: 'codex', pid: 4242, active: [], lastEvent: { endedAt: new Date(NOW - 60_000).toISOString() }, updatedAt: new Date(NOW - 60_000).toISOString() }),
      '/home/op/.omelette/fleet-log.ndjson': '{}',
    } })

    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })
    await $.session.start(SESSION)
    await clock.advance(2_100)

    const codex = world.fleet?.nodes.find(node => node.id === 'unit:codex')

    expect(codex).toMatchObject({ feed: 'ok', lastEndedAt: NOW - 60_000 })
    expect(world.fleet?.isOpen).toBe(true)
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

  test('session.measure updates the usage figures the header shows, and hands its result on', async ($, on) => {
    const world = worldOf(on)

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('session.measure', ($$, e) => ({ changed: e.changed }))
    await $.session.start(SESSION)
    expect(await $.session.measure({ context: { window: 1_000_000, percent: 44 }, rateLimits: [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 73 }], cost: { usd: 12.5 }, changed: ['context'] } as never)).toEqual({ changed: ['context'] })
    expect(world.fleet?.usage).toEqual({ contextPercent: 44, fiveHour: 12, sevenDay: 73 })
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
})

describe('the tick', () => {
  const SNAPSHOT = {
    '/home/op/.omelette/status-codex-4242.json': JSON.stringify({ schema: 2, unit: 'codex', pid: 4242, active: [], updatedAt: new Date(NOW - 60_000).toISOString() }),
  }

  test('the command reads the status feed at once: the unit has a feed before the first tick', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on, { files: SNAPSHOT })

    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    await $.session.start(SESSION)
    await $.command.run(command())

    expect(world.fleet?.nodes.find(node => node.id === 'unit:codex')?.feed).toBe('ok')
  })

  for (const [name, value, dir] of [['padded', '  /srv/fleet \n', '/srv/fleet'], ['blank', ' \t ', '/home/op/.omelette']] as const) {
    test(`a ${name} OMELETTE_HOME reads the status feed from ${dir}`, { options: { autoOpen: false } }, async ($, on) => {
      const world = worldOf(on, { files: { [`${dir}/status-codex-4242.json`]: SNAPSHOT['/home/op/.omelette/status-codex-4242.json'] } })

      mock.clock(on, { now: NOW })
      mock.env(on, { HOME, OMELETTE_HOME: value })
      await $.session.start(SESSION)
      await $.command.run(command())

      expect(nodeOf(world, 'unit:codex')?.feed).toBe('ok')
    })
  }

  test('a tick held on the engine across a close, a reopen and a reload, then let go, changes neither isOpen nor the new chain; one chain ticks', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })
    let release: (panes: { id: string; isPlaced: boolean }[]) => void = () => undefined

    mock.env(on, { HOME })
    await $.session.start(SESSION)
    await $.command.run(command())
    world.heldAsk = new Promise(resolve => (release = resolve))
    await clock.advance(1_000)
    expect(world.heldAsk, 'the first chain\'s tick asked and is held').toBeUndefined()

    await $.command.run(command('close'))
    await $.command.run(command())
    await $.session.start(SESSION)
    expect(world.fleet?.isOpen).toBe(true)
    expect(await asksIn(clock, world, 2_000), 'the new chain ticks while the old tick is still held').toBe(2)

    // The held answer is the engine's as of the close: no pane.
    release([])
    await clock.settle()
    expect(world.fleet?.isOpen, 'the old tick wrote no close').toBe(true)
    await clock.advance(1_000)
    expect(await asksIn(clock, world, 3_000), 'one chain, a tick a second').toBe(3)
  })

  test('with the pane closed, the orchestrator\'s model requests refresh the agent list (at most every 5 s): an agent the engine lists idle leaves the status line', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    on('turn.step', async function* () {
      return STEPPED
    })
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    expect(world.statuses.at(-1), 'the agent runs').toContain('coder')
    world.agents = [{ id: SPAWNED.agentId, type: 'omelette-coder', status: 'idle', description: 'x' } as never]
    await clock.advance(5_000)
    await step($ as never, undefined, 'high')
    expect(world.statuses.at(-1), 'the idle agent is gone from the status line').toBeUndefined()
  })

  test('a close whose pane-list answer is held while the pane is reopened, then let go, stops nothing: the reopened pane stays open and ticking', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })
    let release: (panes: { id: string; isPlaced: boolean }[]) => void = () => undefined

    mock.env(on, { HOME })
    await $.session.start(SESSION)
    await $.command.run(command())
    world.heldAsk = new Promise(resolve => (release = resolve))

    const closing = $.command.run(command('close'))

    await clock.settle()
    await $.command.run(command())
    release([])
    await closing
    await clock.settle()
    expect(world.fleet?.isOpen, 'the reopened pane is open').toBe(true)
    expect(await asksIn(clock, world, 3_000), 'its chain still ticks').toBe(3)
  })

  test('an open whose feed read is held across a close, then let go, writes nothing: the model stays closed', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on, { files: SNAPSHOT })
    const clock = mock.clock(on, { now: NOW })
    let release: () => void = () => undefined

    mock.env(on, { HOME })
    await $.session.start(SESSION)
    world.hold = new Promise(resolve => (release = resolve))

    const opening = $.command.run(command())

    await clock.settle()
    expect(world.lists, 'the open\'s feed read is held').toBe(1)
    await $.command.run(command('close'))
    expect(world.fleet?.isOpen).toBe(false)

    const writes = world.writes

    release()
    world.hold = undefined
    await opening
    await clock.settle()
    expect(world.fleet?.isOpen, 'the stale open wrote no open').toBe(false)
    expect(world.writes, 'nothing written').toBe(writes)
  })

  test('a tick whose feed read is held across a close, then let go, writes nothing: the model stays closed, the status line is not cleared', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on, { files: SNAPSHOT })
    const clock = mock.clock(on, { now: NOW })
    let release: () => void = () => undefined

    mock.env(on, { HOME })
    await $.session.start(SESSION)
    await $.command.run(command())
    world.hold = new Promise(resolve => (release = resolve))
    await clock.advance(2_000)
    expect(world.lists, 'the second tick passed the pane check and is held on the feed').toBe(2)
    await $.command.run(command('close'))
    expect(world.fleet?.isOpen).toBe(false)

    const writes = world.writes
    const statuses = world.statuses.length

    release()
    world.hold = undefined
    await clock.settle()
    expect(world.fleet?.isOpen, 'the stale tick wrote no open').toBe(false)
    expect(world.writes, 'nothing written').toBe(writes)
    expect(world.statuses.length, 'no status set').toBe(statuses)
  })

  test('while a tick\'s feed read is held no other tick starts (the chain arms its next once the last is over); once it is let go, the next feed tick reads again', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on, { files: SNAPSHOT })
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })
    await $.session.start(SESSION)
    await $.command.run(command())
    expect(world.lists, 'the read at open').toBe(1)

    let release: () => void = () => undefined

    world.hold = new Promise(resolve => (release = resolve))
    await clock.advance(2_000)
    expect(world.lists, 'the second tick reads the feed and is held').toBe(2)

    await clock.advance(2_000)
    expect(world.lists, 'no tick starts while it is held').toBe(2)

    release()
    world.hold = undefined
    await clock.settle()
    await clock.advance(2_000)
    expect(world.lists, 'once it is let go, the next feed tick reads again').toBe(3)
  })
})

describe('the tick rates', () => {
  test('a unit that runs moves the tick like an agent does: 250 ms, and a second once its call returns', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })
    let release: (value: unknown) => void = () => undefined

    mock.env(on, { HOME })
    on('tool.call', () => new Promise(resolve => (release = resolve)) as never)
    await $.session.start(SESSION)
    await $.command.run(command())

    const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN })
    const call = $.tool.call({ tool: 'mcp__orion-grok__grok_code_review', prompt: 'review', cwd: '/home/op/work' } as never)

    await clock.settle()
    await clock.advance(1_000)
    expect(await asksIn(clock, world, 1_000), 'a unit runs').toBe(4)

    release(UNIT_RESULT)
    await call
    await clock.advance(1_000)
    expect(await asksIn(clock, world, 1_000), 'its call returned').toBe(1)
    await pane.unmount()
  })

  test('the status feed is read at open and then at most every 2 s, not at every 250 ms tick', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command())

    const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN })

    expect(world.lists, 'at open').toBe(1)
    await clock.advance(1_000)

    const before = world.lists

    await clock.advance(8_000)
    expect(world.lists - before, 'nine seconds of 250 ms ticks').toBeLessThanOrEqual(5)
    expect(world.lists - before).toBeGreaterThanOrEqual(3)
    await pane.unmount()
  })

  test('opened by the command and not yet drawn, the tick is a second even with an agent running: the surface is unknown', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command())
    await clock.advance(1_000)
    expect(await asksIn(clock, world, 1_000)).toBe(1)
  })

  test('a pane drawn on the terminal then on the desktop ticks a second; back on the terminal, 250 ms', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command())

    const terminal = await $.ui.mount({ ...PANE, plugin: PLUGIN })

    await clock.advance(1_000)
    expect(await asksIn(clock, world, 1_000), 'terminal').toBe(4)
    await terminal.unmount()

    const desktop = await $.ui.mount({ ...PANE, plugin: PLUGIN, surface: 'desktop' })

    await clock.advance(1_000)
    expect(await asksIn(clock, world, 1_000), 'last drawn on the desktop').toBe(1)
    await desktop.unmount()

    const again = await $.ui.mount({ ...PANE, plugin: PLUGIN })

    await clock.advance(1_000)
    expect(await asksIn(clock, world, 1_000), 'last drawn on the terminal again').toBe(4)
    await again.unmount()
  })

  test('one chain at a time: closing and reopening before the next tick, and a second session.start, never double the tick', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command())

    const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN })

    await clock.advance(1_000)
    await $.command.run(command('close'))
    await $.command.run(command())
    await $.session.start(SESSION)
    await $.command.run(command())
    await clock.advance(1_000)
    expect(await asksIn(clock, world, 1_000), 'still one 250 ms chain').toBe(4)
    await pane.unmount()
  })

  test('after a close the tick stops for good, even with an agent running', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command())

    const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN })

    await clock.advance(1_000)
    await $.command.run(command('close'))
    await clock.advance(2_000)
    expect(await asksIn(clock, world, 5_000), 'the chain ended at its next tick').toBe(0)
    await pane.unmount()
  })
})

describe('the tick when the pane is not drawn', () => {
  test('a pane opened unasked that waits unplaced (a narrow terminal): its ticks ask for the panes and write no state, read no feed', async ($, on) => {
    const world = worldOf(on, { placed: false })
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })
    await $.session.start(SESSION)
    await clock.settle()
    expect(world.opened).toEqual(['omelette-fleet'])

    const writes = world.writes

    expect(await asksIn(clock, world, 5_000), 'it ticks').toBe(5)
    expect(world.writes, 'no state written').toBe(writes)
    expect(world.lists, 'no feed read').toBe(0)
  })

  test('a pane drawn on the terminal that the engine then un-seats (a narrow terminal) ticks a second: nothing is open to move', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command())

    const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN })

    await clock.advance(1_000)
    expect(await asksIn(clock, world, 1_000), 'seated').toBe(4)

    world.panes = world.panes.map(one => ({ ...one, isPlaced: false }))
    await clock.advance(1_000)
    expect(await asksIn(clock, world, 1_000), 'no longer seated').toBe(1)
    expect(world.fleet?.isOpen, 'an un-seated pane is not open').toBe(false)
    expect(world.statuses.at(-1), 'the status line is back').toContain('fleet:')
    await pane.unmount()
  })

  test('a pane the engine closes by itself (no ui.close through the plugin) ends the tick at its next turn, even with an agent running', { options: { autoOpen: false } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })

    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command())

    const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN })

    await clock.advance(1_000)
    world.panes = []
    await clock.advance(2_000)
    expect(await asksIn(clock, world, 5_000)).toBe(0)
    await pane.unmount()
  })
})

describe('the option reaches the desktop drawing', () => {
  test('the SVG carries the motion by default, inside the reduced-motion query, and none with animate off', { options: { autoOpen: false } }, async ($, on) => {
    worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    await $.session.start(SESSION)
    await $.command.run(command())

    const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN, surface: 'desktop' })
    const svg = (await pane.findAll({ type: 'Svg' }))[0]
    const source = String(svg?.props.source)

    expect(source).toContain('@media (prefers-reduced-motion: no-preference){')
    expect(source).toContain('@keyframes')
    await pane.unmount()
  })

  test('animate off: the same SVG without the keyframes or the query', { options: { autoOpen: false, animate: false } }, async ($, on) => {
    worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    await $.session.start(SESSION)
    await $.command.run(command())

    const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN, surface: 'desktop' })
    const source = String((await pane.findAll({ type: 'Svg' }))[0]?.props.source)

    expect(source).toMatch(/^<svg /)
    expect(source).not.toContain('animation')
    expect(source).not.toContain('prefers-reduced-motion')
    await pane.unmount()
  })
})

describe('motion', () => {
  test('the tick runs every 250 ms while an agent runs, and every second once nothing does', { options: { autoOpen: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = worldOf(on)

    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    on('classic.SubagentStop', () => ({}))
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command())

    const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN })

    await clock.advance(1_000)

    let before = world.asks

    await clock.advance(1_000)
    expect(world.asks - before, 'an agent runs').toBe(4)

    await $.classic.SubagentStop({ agent_id: 'agent-c1', agent_type: 'omelette-coder-medium', agent_transcript_path: '', stop_hook_active: false } as never)
    await clock.advance(1_000)
    before = world.asks
    await clock.advance(1_000)
    expect(world.asks - before, 'nothing runs').toBe(1)
    await pane.unmount()
  })

  test('an agent the engine lists idle after its spawn, with no stop, reads waiting after the next feed tick: not running, not spinning, not holding the fast tick', { options: { autoOpen: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = worldOf(on)

    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command())

    const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN })

    await clock.advance(1_000)
    expect(await asksIn(clock, world, 1_000), 'it runs').toBe(4)

    world.agents = [{ id: 'agent-c1', type: 'omelette-coder-medium', status: 'idle', description: 'Run the suite' }]
    await clock.advance(2_000)
    expect(nodeOf(world, 'agent-c1')?.status).toBe('waiting')
    expect(await asksIn(clock, world, 1_000), 'nothing runs').toBe(1)
    await pane.unmount()

    const again = await $.ui.mount({ ...PANE, plugin: PLUGIN })

    expect(await again.find({ type: 'Text', text: '│ ◌ coder-medium│' }), 'the waiting glyph, no spinner').toBeDefined()
    await again.unmount()
  })

  test('a pane drawn on the desktop ticks every second with an agent running: no spinner there, and its SVG animates itself', { options: { autoOpen: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = worldOf(on)

    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command())

    const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN, surface: 'desktop' })

    await clock.advance(1_000)

    const before = world.asks

    await clock.advance(1_000)
    expect(world.asks - before).toBe(1)
    await pane.unmount()
  })

  test('animate off: the tick stays at a second with an agent running, and the box shows a static ▶', { options: { autoOpen: false, animate: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = worldOf(on)

    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command())

    const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN })

    expect(await pane.find({ type: 'Text', text: '│ ▶ coder-medium│' })).toBeDefined()
    await clock.advance(1_000)

    const before = world.asks

    await clock.advance(1_000)
    expect(world.asks - before, 'drawn on the terminal, still a second').toBe(1)
    await pane.unmount()
  })
})

describe('the pane', () => {
  test('mounted on the terminal at 53 columns it draws the frames, in the terminal\'s own elements', async ($, on) => {
    worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)

    const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN })

    expect(await pane.find({ type: 'Text', text: `${' '.repeat(18)}┌───────────────┐` }), 'the agent\'s box').toBeDefined()
    expect(await pane.find({ type: 'Text', text: '│ ⠋ coder-medium│' }), 'the spinner\'s first frame').toBeDefined()
    expect(await pane.find({ type: 'Text', text: '└───────────────┘ └───────────────┘ └───────────────┘' }), 'the units\' frames').toBeDefined()
    expect(await pane.find({ type: 'Text', text: '● orchestrator' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'ctx 31% · 5h 11% · 7d 71%' })).toBeDefined()
    await pane.unmount()
  })

  test('on the desktop, VS Code and mobile: the header, one Svg of the graph with its alt and width, then the history as Text', async ($, on) => {
    worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)

    for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
      const pane = await $.ui.mount({ ...PANE, surface, plugin: PLUGIN })
      const svgs = await pane.findAll({ type: 'Svg' })

      expect(svgs, surface).toHaveLength(1)
      expect(String(svgs[0]?.props.source)).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" [^>]*>.*<\/svg>$/)
      expect(String(svgs[0]?.props.alt)).toContain('│ ▶ coder-medium│')
      expect(typeof svgs[0]?.props.width).toBe('number')
      expect(await pane.find({ type: 'Text', text: 'ctx 31% · 5h 11% · 7d 71%' }), surface).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /^\d\d:\d\d:\d\d orchestrator → coder-medium · Agent$/ }), surface).toBeDefined()
      expect(await pane.find({ type: 'Text', text: '┌───────────────┐' }), 'no terminal frame drawn as text').toBeUndefined()
      await pane.unmount()
    }
  })

  for (const [name, env] of [['NO_COLOR', { HOME, NO_COLOR: '1' }], ['TERM=dumb', { HOME, TERM: 'dumb' }]] as const) {
    test(`with ${name} the frames are ASCII and no segment carries a style`, async ($, on) => {
      worldOf(on)
      mock.clock(on, { now: NOW })
      mock.env(on, env)
      await $.session.start(SESSION)

      const pane = await $.ui.mount({ ...PANE, plugin: PLUGIN })
      const texts = await pane.findAll({ type: 'Text' })

      expect(await pane.find({ type: 'Text', text: '+---------------+ +---------------+ +---------------+' })).toBeDefined()
      expect(texts.some(text => /[─│┌┐└┘●▶]/.test(String(text.text)))).toBe(false)
      expect(texts.some(text => text.props.color !== undefined || text.props.bold !== undefined || text.props.dimColor !== undefined)).toBe(false)
      await pane.unmount()
    })
  }
})

describe('the pane, its colours and its rows', () => {
  const textsOf = async (pane: { findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }) => (await pane.findAll({ type: 'Text' }))
  type Node = { type?: string; children?: unknown[] }
  const flat = (item: unknown): string => (typeof item === 'string' ? item : ((item as Node).children ?? []).map(flat).join(''))
  /** The pane's rows: the children of the root Box, as text. */
  const rowsOf = async (pane: { drawn: () => Promise<unknown> }) => ((await pane.drawn()) as Node).children?.map(flat) ?? []

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
})

describe('the pane on a surface that draws an Svg', () => {
  type Node = { children?: (Node | string)[] }
  const flat = (item: unknown): string => (typeof item === 'string' ? item : ((item as Node).children ?? []).map(flat).join(''))

  /** Six history links: the spawn, four unit calls, the stop's report. */
  async function seeded($: any, on: On) {
    worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    on('tool.call', () => UNIT_RESULT)
    on('classic.SubagentStop', () => ({}))
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)

    for (const [i, tool] of ['codex_code_review', 'codex_research', 'grok_research', 'gemini_research'].entries()) {
      const unit = tool.split('_')[0]
      await $.tool.call({ tool: `mcp__orion-${unit}__${tool}`, prompt: 'p', cwd: '/home/op/work', agentId: 'agent-c1', tool_use_id: `toolu_u${i}` } as never)
    }

    await $.classic.SubagentStop(STOP as never)
  }

  const local = (at: number) => [new Date(at).getHours(), new Date(at).getMinutes(), new Date(at).getSeconds()].map(n => String(n).padStart(2, '0')).join(':')

  const historyOf = async (pane: any) => {
    const texts = await pane.findAll({ type: 'Text' })

    return texts.map((t: any) => String(t.text)).filter((t: string) => /^\d\d:\d\d:\d\d /.test(t))
  }

  test('the history under the Svg is the pane\'s rows (at least three), newest first, each row within the pane\'s columns', async ($, on) => {
    await seeded($, on)

    for (const [bodyRows, expected] of [[2, 3], [5, 5], [40, 6]] as const) {
      const pane = await $.ui.mount({ ...PANE, surface: 'desktop', plugin: PLUGIN, props: { ...PANE.props, bodyColumns: 40, scroll: { offset: 0, bodyRows } } })
      const rows = await historyOf(pane)

      expect(rows.length, `bodyRows ${bodyRows}`).toBe(expected)
      expect(rows[0], 'newest first').toContain('coder-medium → orchestrator')
      expect(rows[0], 'the time in the host\'s zone').toMatch(new RegExp(`^${local(NOW)} `))
      expect(rows.every((row: string) => [...row].length <= 40), 'within bodyColumns').toBe(true)
      const [svg] = await pane.findAll({ type: 'Svg' })

      expect(String(svg?.props.alt), 'the alt\'s history in the host\'s zone too').toContain(`${local(NOW)} coder-medium → orchestrator`)
      await pane.unmount()
    }
  })
})

describe('the mod observes and never changes what it sees', () => {
  test('every hook hands on the result its next returned', async ($, on) => {
    const world = worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('agent.spawn', () => SPAWNED)
    on('tool.call', () => BASH_RESULT)
    on('classic.SubagentStop', () => ({ block: 'not yet' }))
    on('session.measure', ($, e) => ({ changed: e.changed }))
    on('turn.step', async function* () {
      return STEPPED
    })
    await $.session.start(SESSION)

    expect(await $.agent.spawn(SPAWN as never)).toEqual(SPAWNED)
    expect(await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'agent-c1' } as never)).toMatchObject(BASH_RESULT)
    expect(await step($ as never, 'agent-c1', 'medium')).toEqual(STEPPED)
    expect(await $.classic.SubagentStop({ agent_id: 'agent-c1', agent_type: 'omelette-coder-medium', agent_transcript_path: '', stop_hook_active: false } as never)).toMatchObject({ block: 'not yet' })
    expect(await $.session.measure({ context: { window: 1_000_000, percent: 40 }, rateLimits: [], changed: ['context'] } as never)).toEqual({ changed: ['context'] })

    const agent = world.fleet?.nodes.find(node => node.id === 'agent-c1')

    expect(agent?.status, 'a blocked stop leaves the agent running').toBe('running')
  })

  test('a hook whose bookkeeping throws (the clock is gone) leaves the tool call\'s result as it was without the mod', async ($, on) => {
    on('clock.now', () => {
      throw new Error('the clock is gone')
    })
    on('tool.call', () => BASH_RESULT)

    expect(await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)).toMatchObject(BASH_RESULT)
    expect(await $.tool.call({ tool: 'mcp__orion-gemini__gemini_research', question: 'q' } as never)).toMatchObject(BASH_RESULT)
  })

  test('a hook whose state write is refused leaves the spawn\'s and the tool call\'s results as they were', async ($, on) => {
    mock.clock(on, { now: NOW })
    on('state.set', () => ({ deny: 'no writes in this test' }))
    on('agent.spawn', () => SPAWNED)
    on('tool.call', () => UNIT_RESULT)

    expect(await $.agent.spawn(SPAWN as never)).toEqual(SPAWNED)
    expect(await $.tool.call({ tool: 'mcp__orion-codex__codex_code_review', prompt: 'p', cwd: '/home/op/work' } as never)).toMatchObject(UNIT_RESULT)
  })
})

describe('guard v2: the mod runs the rendered guard (1.8.0)', () => {
  const CWD = '/home/op/work'
  const SCRIPT = `${CWD}/.claude/hooks/omelette-guard.mjs`
  const NODE_DIR = '/opt/node/bin'
  const REFUSAL = 'omelette-coder never commits: the orchestrator commits reviewed work'

  type Run = { argv: readonly string[]; init?: { stdin?: string; timeoutMs?: number; env?: Record<string, string> } }
  type Answer = { exitCode: number; stderr?: string } | { reject: string }
  type Guard = { runs: Run[]; logs: string[]; tools: string[] }

  /**
   * The engine beneath the guard hook: the loop's directory, which files exist
   * (the rendered scripts, `node` in a PATH entry), what `node <script>` answers,
   * the transcript lines the plugin logs, and the tools that ran beneath it.
   */
  function guardOf(on: On, { scripts = [SCRIPT], nodes = [`${NODE_DIR}/node`], answer = { exitCode: 0 } }: { scripts?: string[]; nodes?: string[]; answer?: Answer } = {}): Guard {
    const guard: Guard = { runs: [], logs: [], tools: [] }

    on('session.cwd', () => ({ value: CWD }))
    on('fs.exists', ($, e) => ({ value: scripts.includes(e.path) || nodes.includes(e.path) }))
    on('process.run', ($, e) => {
      guard.runs.push(e as Run)

      return 'reject' in answer ? ({ deny: answer.reject } as never) : { value: { exitCode: answer.exitCode, stdout: '', stderr: answer.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('ui.log', ($, e) => {
      guard.logs.push(e.text)

      return { value: undefined }
    })
    on('tool.call', ($, e) => {
      guard.tools.push(String(e.tool))

      return BASH_RESULT
    })

    return guard
  }

  const eventOf = (run: Run | undefined) => JSON.parse(run?.init?.stdin ?? 'null')

  async function coderLoop($: any, on: On) {
    on('agent.spawn', () => SPAWNED)
    await $.session.start(SESSION)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder' } as never)
  }

  test('(a) a Bash call in an omelette-coder loop: node runs the project\'s rendered script with the PreToolUse event, and exit 2 refuses the call with its stderr', async ($, on) => {
    const world = worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME, PATH: `${NODE_DIR}:node_modules/.bin:/usr/bin` })
    const guard = guardOf(on, { scripts: [SCRIPT, `${HOME}/.claude/hooks/omelette-guard.mjs`], answer: { exitCode: 2, stderr: `${REFUSAL}\n` } })
    await coderLoop($, on)

    const result = await $.tool.call({ tool: 'Bash', command: 'git commit -m wip', agentId: 'agent-c1', tool_use_id: 'toolu_c1' } as never)

    expect(guard.runs.map(run => run.argv)).toEqual([['node', SCRIPT]])
    expect(guard.runs[0]?.init?.timeoutMs).toBe(2000)
    expect(guard.runs[0]?.init?.env, 'node from PATH, its absolute entries only').toEqual({ PATH: `${NODE_DIR}:/usr/bin` })
    expect(eventOf(guard.runs[0])).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m wip' }, agent_type: 'omelette-coder', cwd: CWD })
    expect(result).toMatchObject({ deny: REFUSAL })
    expect(guard.tools, 'the tool never ran').toEqual([])
    expect(nodeOf(world, 'agent-c1')?.activity, 'the row shows the refusal').toBe('refused')
    expect(world.fleet?.counts?.refusals).toEqual({ mod: 1 })
  })

  test('(b) exit 0: the call goes through, the guard asked once', async ($, on) => {
    worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME, PATH: NODE_DIR })
    const guard = guardOf(on, { answer: { exitCode: 0 } })
    await coderLoop($, on)

    expect(await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'agent-c1', tool_use_id: 'toolu_c2' } as never)).toMatchObject(BASH_RESULT)
    expect(guard.runs).toHaveLength(1)
    expect(guard.tools).toEqual(['Bash'])
    expect(guard.logs).toEqual([])
  })

  for (const [name, answer] of [['exit 1', { exitCode: 1, stderr: 'SyntaxError: Unexpected token' }], ['a rejection (timeout)', { reject: 'still running after 2000 ms' }]] as const) {
    test(`(c) ${name}: the call goes through, and the mod denies nothing of its own`, async ($, on) => {
      const world = worldOf(on)
      mock.clock(on, { now: NOW })
      mock.env(on, { HOME, PATH: NODE_DIR })
      const guard = guardOf(on, { answer })
      await coderLoop($, on)

      expect(await $.tool.call({ tool: 'Edit', file_path: `${CWD}/a.mjs`, old_string: 'a', new_string: 'b', agentId: 'agent-c1', tool_use_id: 'toolu_c3' } as never)).toMatchObject(BASH_RESULT)
      expect(guard.runs).toHaveLength(1)
      expect(guard.tools).toEqual(['Edit'])
      expect(guard.logs, 'node is on PATH: nothing to say').toEqual([])
      expect(world.fleet?.counts).toBeUndefined()
    })
  }

  test('(d) no rendered script, in the project or under HOME: every call goes through, node never runs, and the mod says so once', async ($, on) => {
    worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME, PATH: NODE_DIR })
    const guard = guardOf(on, { scripts: [] })
    await coderLoop($, on)

    expect(await $.tool.call({ tool: 'Bash', command: 'git commit -m wip', agentId: 'agent-c1', tool_use_id: 'toolu_d1' } as never)).toMatchObject(BASH_RESULT)
    expect(await $.tool.call({ tool: 'Write', file_path: `${CWD}/b.md`, content: 'b', tool_use_id: 'toolu_d2' } as never)).toMatchObject(BASH_RESULT)
    expect(guard.runs).toEqual([])
    expect(guard.tools).toEqual(['Bash', 'Write'])
    expect(guard.logs).toEqual(['guard v2: no rendered script — omelette-fleet rules --hooks'])
  })

  test('(d) the script under HOME when the project has none; no node on PATH: every call goes through and the mod says so once', async ($, on) => {
    worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME, PATH: `${NODE_DIR}:/usr/bin` })
    const home = `${HOME}/.claude/hooks/omelette-guard.mjs`
    const guard = guardOf(on, { scripts: [home], nodes: [], answer: { reject: 'spawn node ENOENT' } })
    await coderLoop($, on)

    expect(await $.tool.call({ tool: 'Bash', command: 'git commit -m wip', agentId: 'agent-c1', tool_use_id: 'toolu_d3' } as never)).toMatchObject(BASH_RESULT)
    expect(await $.tool.call({ tool: 'Bash', command: 'git push', agentId: 'agent-c1', tool_use_id: 'toolu_d4' } as never)).toMatchObject(BASH_RESULT)
    expect(guard.runs.map(run => run.argv[1]), 'the HOME copy is the one asked').toEqual([home, home])
    expect(guard.tools).toEqual(['Bash', 'Bash'])
    expect(guard.logs).toEqual(['guard v2: node not found on PATH'])
  })

  test('(e) the main thread\'s Write: the script is asked with no agent_type', async ($, on) => {
    worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME, PATH: NODE_DIR })
    const guard = guardOf(on)
    await $.session.start(SESSION)

    await $.tool.call({ tool: 'Write', file_path: `${CWD}/.omelette/ledger-x.md`, content: '# ledger\n', tool_use_id: 'toolu_e1' } as never)

    expect(eventOf(guard.runs[0])).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: `${CWD}/.omelette/ledger-x.md`, content: '# ledger\n' }, cwd: CWD })
  })

  test('(f) a SubagentStop for a coder: the row notes its touched record and how many files it lists', async ($, on) => {
    const record = `${CWD}/.omelette/reports/touched-omelette-coder-a1b2c3d4.md`
    const world = worldOf(on, { files: { [record]: '# touched — omelette-coder a1b2c3d4e5f6\n\ntranscript: /home/op/.claude/projects/x/a.jsonl\n\n- a.mjs (Write)\n- b.md (bash >, after cd)\n\ntool calls: 3 (Write: 1, Bash: 1, Read: 1)\n' } })
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1b2c3d4e5f6' }))
    on('classic.SubagentStop', () => ({}))
    await $.session.start(SESSION)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder' } as never)

    await $.classic.SubagentStop({ ...STOP, agent_id: 'a1b2c3d4e5f6', agent_type: 'omelette-coder', cwd: CWD } as never)

    expect(nodeOf(world, 'a1b2c3d4e5f6')).toMatchObject({ status: 'reported', touched: 'touched: .omelette/reports/touched-omelette-coder-a1b2c3d4.md — 2 files' })
  })
})

describe('pins, the effort flag and the effort variable (1.8.0)', () => {
  const CWD = SESSION.cwd
  /** The rendered omelette-coder definition, as `rules --agents` writes it. */
  const CODER = [
    '---',
    '# omelette-fleet agent v1.8.0 · managed by `omelette-fleet rules --agents` · edits are overwritten on refresh',
    'name: omelette-coder',
    'description: Implements ONE task from a written brief — code and tests only, no commits unless the brief says so.',
    'model: claude-opus-5-5',
    'effort: xhigh',
    'disallowedTools: Agent',
    '---',
    '',
    'You implement exactly one task from the brief the orchestrator gives you.',
    '',
  ].join('\n')
  const FILES = { [`${CWD}/.claude/agents/omelette-coder.md`]: CODER }
  const NOTICE = 'CLAUDE_CODE_EFFORT_LEVEL=low is set: it overrides every agent definition\'s effort (rules, "Spawning sub-agents")'

  type Seen = { models: (string | undefined)[]; toasts: string[] }

  /** The engine beneath: the model each spawn reached it with, and the toasts the plugin raised. */
  function engineOf(on: On): Seen {
    const seen: Seen = { models: [], toasts: [] }

    on('agent.spawn', ($, e) => {
      seen.models.push(e.model)

      return SPAWNED
    })
    on('ui.toast', ($, e) => {
      seen.toasts.push(e.text)

      return { value: undefined }
    })
    on('turn.step', async function* () {
      return STEPPED
    })

    return seen
  }

  test('(a) omelette-coder spawned on haiku: the engine sees the definition\'s model, one toast, one pin counted', async ($, on) => {
    const world = worldOf(on, { files: FILES })
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    const seen = engineOf(on)
    await $.session.start(SESSION)

    const result = await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder', model: 'haiku' } as never)

    expect(seen.models).toEqual(['claude-opus-5-5'])
    expect(result).toEqual(SPAWNED)
    expect(seen.toasts).toEqual(['pinned omelette-coder to claude-opus-5-5'])
    expect(world.fleet?.counts?.pins).toBe(1)
    expect(nodeOf(world, 'agent-c1')).toMatchObject({ role: 'omelette-coder', model: 'claude-opus-5-5', pinned: { from: 'haiku', to: 'claude-opus-5-5' } })
  })

  test('(a\') the engine runs the pinned spawn on another model (a session-forced subagent model): the override toast, no pin counted, the row on the engine\'s model', async ($, on) => {
    const world = worldOf(on, { files: FILES })
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    const seen: Seen = { models: [], toasts: [] }
    const answer = { model: 'claude-haiku-5-5', agentId: 'agent-c1' }

    on('agent.spawn', ($$, e) => {
      seen.models.push(e.model)

      return answer
    })
    on('ui.toast', ($$, e) => {
      seen.toasts.push(e.text)

      return { value: undefined }
    })
    await $.session.start(SESSION)

    expect(await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder', model: 'haiku' } as never)).toEqual(answer)
    expect(seen.models, 'the pin went down').toEqual(['claude-opus-5-5'])
    expect(seen.toasts).toEqual(['omelette-coder runs on claude-haiku-5-5: the session\'s forced subagent model outranks the definition\'s claude-opus-5-5'])
    expect(world.fleet?.counts?.pins).toBeUndefined()
    expect(nodeOf(world, 'agent-c1')).toMatchObject({ role: 'omelette-coder', model: 'claude-haiku-5-5' })
    expect(nodeOf(world, 'agent-c1')?.pinned).toBeUndefined()
  })

  test('(b) omelette-coder spawned on opus, the alias of its model: unchanged, no toast, no pin', async ($, on) => {
    const world = worldOf(on, { files: FILES })
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    const seen = engineOf(on)
    await $.session.start(SESSION)

    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder', model: 'opus' } as never)

    expect(seen.models).toEqual(['opus'])
    expect(seen.toasts).toEqual([])
    expect(world.fleet?.counts?.pins).toBeUndefined()
  })

  test('(c) omelette-coder spawned with no model: unchanged, no toast', async ($, on) => {
    worldOf(on, { files: FILES })
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    const seen = engineOf(on)
    await $.session.start(SESSION)

    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder' } as never)

    expect(seen.models).toEqual([undefined])
    expect(seen.toasts).toEqual([])
  })

  test('(d) Explore spawned on haiku: not a pinned role, unchanged', async ($, on) => {
    worldOf(on, { files: FILES })
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    const seen = engineOf(on)
    await $.session.start(SESSION)

    await $.agent.spawn({ ...SPAWN, subagentType: 'Explore', model: 'haiku' } as never)

    expect(seen.models).toEqual(['haiku'])
    expect(seen.toasts).toEqual([])
  })

  test('(e) an omelette-coder step on medium: one toast and the row flagged; a second step: no second toast', async ($, on) => {
    const world = worldOf(on, { files: FILES })
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    const seen = engineOf(on)
    await $.session.start(SESSION)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder' } as never)

    expect(await step($ as never, 'agent-c1', 'medium'), 'the step goes on as it came').toEqual(STEPPED)
    expect(seen.toasts).toEqual(['effort medium on omelette-coder (definition says xhigh)'])
    expect(nodeOf(world, 'agent-c1')).toMatchObject({ effort: 'medium', effortFlag: { effort: 'medium', expected: 'xhigh' } })

    await step($ as never, 'agent-c1', 'medium')
    expect(seen.toasts, 'once per agent').toHaveLength(1)
  })

  test('(f) session.start with CLAUDE_CODE_EFFORT_LEVEL=low: the notice', async ($, on) => {
    worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME, CLAUDE_CODE_EFFORT_LEVEL: 'low' })
    const seen = engineOf(on)

    await $.session.start(SESSION)

    expect(seen.toasts).toEqual([NOTICE])
  })

  test('(f) session.start with CLAUDE_CODE_EFFORT_LEVEL unset: no notice', async ($, on) => {
    worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    const seen = engineOf(on)

    await $.session.start(SESSION)

    expect(seen.toasts).toEqual([])
  })
})

describe('the handoff: a prompt.context block, one copy, the compaction skip (1.8.0)', () => {
  const CWD = '/home/op/work'
  const SCRIPT = `${CWD}/.claude/hooks/omelette-guard.mjs`
  const NODE_DIR = '/opt/node/bin'
  const OMELETTE = `${CWD}/.omelette`
  const MARKER = '--- omelette-fleet · read before continuing ---'
  const SECTIONS = '--- ledger-x.md · last handoff ---\n## Handoff (2026-10-08 — x)\nnext: run npm test\n'
  const PRINT = `${MARKER}\n${SECTIONS}`
  const DATE = { name: 'currentDate', text: "Today's date is 2026-10-08." }
  const SKIP = 'no handoff in the last 30 minutes: write one, then compact again'
  const MIN = 60_000

  type Run = { argv: readonly string[]; init?: { cwd?: string; stdin?: string; timeoutMs?: number; env?: Record<string, string> } }
  type Answer = { stdout: string; exitCode?: number } | { reject: string }
  type Ledger = { text: string; mtimeMs: number }
  type Seen = { runs: Run[]; gits: string[] }

  /**
   * The engine beneath: the loop's directory, the rendered scripts that exist,
   * what `node <script>` answers, the ledgers under `.omelette/` (their text and
   * mtime), and the branches `git show-ref` finds.
   */
  function handoffOf(on: On, { scripts = [SCRIPT], answer = { stdout: '' }, ledgers = {}, branches = [] }: { scripts?: string[]; answer?: Answer; ledgers?: Record<string, Ledger>; branches?: string[] } = {}): Seen {
    const seen: Seen = { runs: [], gits: [] }

    on('session.cwd', () => ({ value: CWD }))
    on('fs.exists', ($, e) => ({ value: scripts.includes(e.path) }))
    on('fs.list', ($, e) =>
      e.path === OMELETTE
        ? { value: Object.entries(ledgers).map(([name, one]) => ({ name, kind: 'file' as const, size: one.text.length, mtimeMs: one.mtimeMs, isLink: false })) }
        : ({ deny: `ENOENT: ${e.path}` } as never),
    )
    on('fs.read', ($, e) => {
      const one = e.path.startsWith(`${OMELETTE}/`) ? ledgers[e.path.slice(OMELETTE.length + 1)] : undefined

      return one ? { value: one.text } : ({ deny: `ENOENT: ${e.path}` } as never)
    })
    on('process.run', ($, e) => {
      const run = e as Run
      const exited = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

      if (run.argv[0] === 'git') {
        const ref = String(run.argv[run.argv.length - 1])

        seen.gits.push(ref)

        return exited(branches.some(branch => ref === `refs/heads/${branch}`) ? 0 : 1)
      }

      seen.runs.push(run)

      return 'reject' in answer ? ({ deny: answer.reject } as never) : exited(answer.exitCode ?? 0, answer.stdout)
    })

    return seen
  }

  const asJson = (text: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })
  const pad = (n: number) => String(n).padStart(2, '0')
  /** The local date at `at`, as a handoff heading spells it. */
  const dayOf = (at: number) => {
    const d = new Date(at)

    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  const ledgerText = (branch: string, heading: string) => ['# ledger x', `branch: ${branch}`, '', heading, 'next: run npm test', ''].join('\n')
  const FRESH = `## Handoff (${dayOf(NOW)} — fresh)`
  const STALE = '## Handoff (2026-09-01 — old)'
  const MESSAGES = [{ role: 'user' as const, text: 'Implement Task 9', toolUses: [] }]
  const COMPACTED = { messages: [{ role: 'user' as const, text: 'the summary', toolUses: [] }] }
  const compact = (trigger: string, more: Record<string, unknown> = {}) => ({ trigger, messages: MESSAGES, ...more }) as never

  test('(a) prompt.context adds omeletteHandoff with the text the rendered guard answered as JSON, at a fire with no compaction before it', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME, PATH: `${NODE_DIR}:node_modules/.bin` })
    const seen = handoffOf(on, { answer: { stdout: asJson(PRINT) } })
    on('prompt.context', () => ({ blocks: [DATE] }))

    const result = await $.prompt.context({ blocks: [DATE] })

    expect(result.blocks).toEqual([DATE, { name: 'omeletteHandoff', text: PRINT }])
    expect(seen.runs.map(run => run.argv)).toEqual([['node', SCRIPT]])
    expect(seen.runs[0]?.init?.timeoutMs).toBe(5000)
    expect(seen.runs[0]?.init?.env, 'node from PATH, its absolute entries only').toEqual({ PATH: NODE_DIR })
    expect(JSON.parse(seen.runs[0]?.init?.stdin ?? 'null')).toEqual({ hook_event_name: 'SessionStart', source: 'clear', cwd: CWD })
  })

  test('(a2) a pre-1.8.0 rendered script prints plain text: the block carries it, trimmed', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME, PATH: NODE_DIR })
    handoffOf(on, { answer: { stdout: `${SECTIONS}\n` } })
    on('prompt.context', () => ({ blocks: [DATE] }))

    expect((await $.prompt.context({ blocks: [DATE] })).blocks).toEqual([DATE, { name: 'omeletteHandoff', text: SECTIONS.trim() }])
  })

  for (const [name, answer] of [['empty stdout', { stdout: '' }], ['a run that rejects (timeout)', { reject: 'still running after 5000 ms' }]] as const) {
    test(`(b) ${name}: no block, next's blocks untouched`, async ($, on) => {
      mock.clock(on, { now: NOW })
      mock.env(on, { HOME, PATH: NODE_DIR })
      const seen = handoffOf(on, { answer })
      on('prompt.context', () => ({ blocks: [DATE] }))

      expect((await $.prompt.context({ blocks: [DATE] })).blocks).toEqual([DATE])
      expect(seen.runs).toHaveLength(1)
    })
  }

  const SUPERPOWERS = 'superpowers: using-superpowers loaded'

  test('(c) classic.SessionStart on clear: the guard\'s marked entry is stripped, every other entry kept', async ($, on) => {
    mock.env(on, { HOME })
    handoffOf(on)
    on('classic.SessionStart', () => ({ additionalContext: [PRINT, SUPERPOWERS] }))

    expect(await $.classic.SessionStart({ source: 'clear', cwd: CWD } as never)).toEqual({ additionalContext: [SUPERPOWERS] })
  })

  test('(c) the marked entry alone on compact: the result carries no additionalContext key at all', async ($, on) => {
    mock.env(on, { HOME })
    handoffOf(on)
    on('classic.SessionStart', () => ({ additionalContext: [PRINT], sessionTitle: 'x' }))

    const result = await $.classic.SessionStart({ source: 'compact', cwd: CWD } as never)

    expect(result).toEqual({ sessionTitle: 'x' })
    expect('additionalContext' in result, 'left out, never undefined').toBe(false)
  })

  test('(c) startup keeps both entries', async ($, on) => {
    mock.env(on, { HOME })
    const beneath = { additionalContext: [PRINT, SUPERPOWERS] }
    on('classic.SessionStart', () => beneath)
    handoffOf(on)

    expect(await $.classic.SessionStart({ source: 'startup', cwd: CWD } as never)).toEqual(beneath)
  })

  test('(c) no rendered script (fs.exists false): clear keeps both entries', async ($, on) => {
    mock.env(on, { HOME })
    const beneath = { additionalContext: [PRINT, SUPERPOWERS] }
    handoffOf(on, { scripts: [] })
    on('classic.SessionStart', () => beneath)

    expect(await $.classic.SessionStart({ source: 'clear', cwd: CWD } as never)).toEqual(beneath)
  })

  test('(d) handoffGate on, a stale open ledger: the compaction is skipped once; a second one a minute later passes', { options: { handoffGate: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const seen = handoffOf(on, { ledgers: { 'ledger-x.md': { text: ledgerText('feat/x', STALE), mtimeMs: NOW - 5 * MIN } }, branches: ['feat/x'] })
    on('session.compact', () => COMPACTED)

    expect(await $.session.compact(compact('manual'))).toEqual({ skip: SKIP })
    expect(seen.gits).toEqual(['refs/heads/feat/x'])

    await clock.advance(MIN)

    expect(await $.session.compact(compact('auto'))).toEqual(COMPACTED)
  })

  for (const [name, input] of [['trigger precompute', compact('precompute')], ['a sub-agent\'s own compaction (agentId)', compact('auto', { agentId: 'agent-c1' })]] as const) {
    test(`(d) ${name}: passes`, { options: { handoffGate: true } }, async ($, on) => {
      mock.clock(on, { now: NOW })
      const seen = handoffOf(on, { ledgers: { 'ledger-x.md': { text: ledgerText('feat/x', STALE), mtimeMs: NOW } }, branches: ['feat/x'] })
      on('session.compact', () => COMPACTED)

      expect(await $.session.compact(input)).toEqual(COMPACTED)
      expect(seen.gits).toEqual([])
    })
  }

  test('(d) the option off (its default): a stale open ledger passes', async ($, on) => {
    mock.clock(on, { now: NOW })
    handoffOf(on, { ledgers: { 'ledger-x.md': { text: ledgerText('feat/x', STALE), mtimeMs: NOW } }, branches: ['feat/x'] })
    on('session.compact', () => COMPACTED)

    expect(await $.session.compact(compact('manual'))).toEqual(COMPACTED)
  })

  test('(d) a closed ledger (its branch gone) newer and fresh beside an open stale one: skipped, the closed one does not count', { options: { handoffGate: true } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = handoffOf(on, {
      ledgers: {
        'ledger-done.md': { text: ledgerText('feat/done', FRESH), mtimeMs: NOW - MIN },
        'ledger-x.md': { text: ledgerText('feat/x', STALE), mtimeMs: NOW - 60 * MIN },
      },
      branches: ['feat/x'],
    })
    on('session.compact', () => COMPACTED)

    expect(await $.session.compact(compact('auto'))).toEqual({ skip: SKIP })
    expect([...seen.gits].sort()).toEqual(['refs/heads/feat/done', 'refs/heads/feat/x'])
  })

  test('(d) a main ledger with a fresh heading: passes, and git never runs', { options: { handoffGate: true } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = handoffOf(on, { ledgers: { 'ledger-lane.md': { text: ledgerText('main', FRESH), mtimeMs: NOW } } })
    on('session.compact', () => COMPACTED)

    expect(await $.session.compact(compact('manual'))).toEqual(COMPACTED)
    expect(seen.gits).toEqual([])
  })
})

// tester 1.8.0 Task 7
describe('tester 1.8.0 Task 7: the guard hook at the engine edge', () => {
  const CWD = '/home/op/work'
  const SCRIPT = `${CWD}/.claude/hooks/omelette-guard.mjs`
  const NODE = '/opt/node/bin/node'
  const OUT = '/home/op/work/.omelette/reports'

  type Answer = { exitCode: number; stdout?: string; stderr?: string } | { reject: string }
  type Spy = { calls: number; stdin: string[]; envs: (Record<string, string> | undefined)[]; logs: string[]; ran: string[]; reads: string[] }

  /** The engine beneath: the rendered script and a `node` that exist, `node <script>` answering `answer`, and the tools that got through. */
  function engine(on: On, { answer = () => ({ exitCode: 0 }) as Answer, exists = [SCRIPT, NODE] }: { answer?: () => Answer; exists?: string[] } = {}): Spy {
    const spy: Spy = { calls: 0, stdin: [], envs: [], logs: [], ran: [], reads: [] }

    on('session.cwd', () => ({ value: CWD }))
    on('fs.exists', ($, e) => ({ value: exists.includes(e.path) }))
    on('process.run', ($, e) => {
      spy.stdin.push(e.init?.stdin ?? '')
      spy.envs.push(e.init?.env)

      spy.calls += 1

      const given = answer()

      return 'reject' in given ? ({ deny: given.reject } as never) : { value: { exitCode: given.exitCode, stdout: given.stdout ?? '', stderr: given.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('ui.log', ($, e) => {
      spy.logs.push(e.text)

      return { value: undefined }
    })
    on('tool.call', ($, e) => {
      spy.ran.push(String(e.tool))

      return BASH_RESULT
    })

    return spy
  }

  async function coder($: any, on: On) {
    on('agent.spawn', () => SPAWNED)
    await $.session.start(SESSION)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder' } as never)
  }

  test('all four tools reach the script with their own fields and the PreToolUse name; Read and Grep never do; the engine\'s keys stay out of tool_input', async ($, on) => {
    worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME, PATH: '/opt/node/bin' })
    const spy = engine(on)
    await coder($, on)
    const rider = { agentId: 'agent-c1', tool_use_id: 'toolu_t1', consent: 'The user pressed "1: Yes"', requestMeta: { k: 'v' } }

    await $.tool.call({ tool: 'Bash', command: 'ls', description: 'list', ...rider } as never)
    await $.tool.call({ tool: 'Write', file_path: `${CWD}/a.md`, content: 'hello', ...rider } as never)
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/a.md`, old_string: 'a', new_string: 'b', ...rider } as never)
    await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${CWD}/n.ipynb`, new_source: 'x', ...rider } as never)
    await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.md`, ...rider } as never)
    await $.tool.call({ tool: 'Grep', pattern: 'x', ...rider } as never)

    const events = spy.stdin.map(text => JSON.parse(text))

    expect(events.map(event => event.tool_name), 'four runs, none for Read or Grep').toEqual(['Bash', 'Write', 'Edit', 'NotebookEdit'])
    expect(events.every(event => event.hook_event_name === 'PreToolUse' && event.agent_type === 'omelette-coder' && event.cwd === CWD)).toBe(true)
    expect(events.map(event => event.tool_input)).toEqual([
      { command: 'ls', description: 'list' },
      { file_path: `${CWD}/a.md`, content: 'hello' },
      { file_path: `${CWD}/a.md`, old_string: 'a', new_string: 'b' },
      { notebook_path: `${CWD}/n.ipynb`, new_source: 'x' },
    ])
    expect(spy.ran, 'every call, guarded or not, went through').toEqual(['Bash', 'Write', 'Edit', 'NotebookEdit', 'Read', 'Grep'])
  })

  test('a call by an agent the pane never saw sends no agent_type; one by a forgotten agent still sends its role', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME, PATH: '/opt/node/bin' })
    const spy = engine(on)
    on('classic.SubagentStop', () => ({}))
    await coder($, on)

    await $.tool.call({ tool: 'Bash', command: 'a', agentId: 'agent-never-seen', tool_use_id: 'toolu_u1' } as never)
    expect(JSON.parse(spy.stdin[0] ?? 'null')).not.toHaveProperty('agent_type')

    await $.classic.SubagentStop({ ...STOP, agent_id: 'agent-c1', agent_type: 'omelette-coder' } as never)
    await clock.advance(11 * 60 * 1000)
    expect(nodeOf(world, 'agent-c1'), 'the pane forgot it').toBeUndefined()

    await $.tool.call({ tool: 'Bash', command: 'b', agentId: 'agent-c1', tool_use_id: 'toolu_u2' } as never)
    expect(JSON.parse(spy.stdin[1] ?? 'null').agent_type).toBe('omelette-coder')
  })

  test('exit 2 with no stderr denies with a fallback text; multi-line stderr is trimmed whole; stdout is not the reason', async ($, on) => {
    worldOf(on)
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME, PATH: '/opt/node/bin' })
    let answer: Answer = { exitCode: 2, stdout: 'SAID ON STDOUT' }
    const spy = engine(on, { answer: () => answer })
    await coder($, on)
    const call = (id: string) => $.tool.call({ tool: 'Bash', command: 'git push', agentId: 'agent-c1', tool_use_id: id } as never)

    const empty = await call('toolu_x1')

    expect(typeof empty.deny, 'a refusal is still a refusal').toBe('string')
    expect(empty.deny).not.toContain('SAID ON STDOUT')
    expect((empty.deny as string).trim().length).toBeGreaterThan(0)

    answer = { exitCode: 2, stderr: '\n  line one\nline two  \n\n' }
    expect((await call('toolu_x2')).deny).toBe('line one\nline two')

    answer = { exitCode: 0, stderr: 'noise that is not a refusal' }
    expect(await call('toolu_x3')).toMatchObject(BASH_RESULT)
    expect(spy.ran, 'only the exit-0 call ran').toEqual(['Bash'])
  })

  for (const path of ['node_modules/.bin:bin', undefined]) {
    test(`PATH ${String(path)}: the call goes through, node is never run, and the notice is said once`, async ($, on) => {
      worldOf(on)
      mock.clock(on, { now: NOW })
      mock.env(on, path === undefined ? { HOME } : { HOME, PATH: path })
      const spy = engine(on, { answer: () => ({ exitCode: 2, stderr: 'would refuse' }) })
      await coder($, on)

      expect(await $.tool.call({ tool: 'Bash', command: 'git push', agentId: 'agent-c1', tool_use_id: 'toolu_p1' } as never)).toMatchObject(BASH_RESULT)
      expect(await $.tool.call({ tool: 'Bash', command: 'git push', agentId: 'agent-c1', tool_use_id: 'toolu_p2' } as never)).toMatchObject(BASH_RESULT)
      expect(spy.calls, 'node never run').toBe(0)
      expect(spy.ran).toEqual(['Bash', 'Bash'])
      expect(spy.logs.filter(line => line.includes('node not found')), 'said once across two calls').toHaveLength(1)
    })
  }

  test('a refusal reaches the pane as `refused` and never as a call; the next call replaces it; two refusals count two; the tick clears it', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME, PATH: '/opt/node/bin' })
    let exitCode = 2
    engine(on, { answer: () => ({ exitCode, stderr: 'no' }) })
    await coder($, on)

    await $.tool.call({ tool: 'Bash', command: 'git push', agentId: 'agent-c1', tool_use_id: 'toolu_r1' } as never)
    expect(nodeOf(world, 'agent-c1')).toMatchObject({ activity: 'refused' })
    expect(nodeOf(world, 'agent-c1')?.loopCalls, 'a refused call is not an open call').toBeUndefined()
    expect(world.fleet?.history.some(link => link.label.includes('Bash'))).toBe(false)

    await $.tool.call({ tool: 'Bash', command: 'git commit', agentId: 'agent-c1', tool_use_id: 'toolu_r2' } as never)
    expect(world.fleet?.counts?.refusals).toEqual({ mod: 2 })

    await clock.advance(2_600)
    expect(nodeOf(world, 'agent-c1')?.activity, 'drawn by a tick, then gone').not.toBe('refused')
    expect(nodeOf(world, 'agent-c1')?.refusedAt).toBeUndefined()

    await $.tool.call({ tool: 'Bash', command: 'git push', agentId: 'agent-c1', tool_use_id: 'toolu_r3' } as never)
    exitCode = 0
    await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'agent-c1', tool_use_id: 'toolu_r4' } as never)
    expect(nodeOf(world, 'agent-c1')?.activity, 'a new call takes the row from the refusal').not.toBe('refused')
    expect(nodeOf(world, 'agent-c1')?.refusedAt).toBeUndefined()
  })

  test('a SubagentStop: no record, a role that is not a file name, a stop a hook beneath blocks, and a stop without a cwd note no touched line and read nothing they should not', async ($, on) => {
    const reads: string[] = []
    const record = `${OUT}/touched-omelette-coder-a1b2c3d4.md`
    const files = new Proxy({ [record]: '# touched\n\n- a (Write)\n- b (Edit)\n- c (Write)\n\ntool calls: 3\n' } as Record<string, string>, {
      get(target, key) {
        if (typeof key === 'string') reads.push(key)

        return target[key as string]
      },
    })
    const world = worldOf(on, { files })
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    let beneath: { block?: string } = {}
    on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: e.tool_use_id === 'toolu_s2' ? 'bbbb2222cccc' : 'a1b2c3d4e5f6' }))
    on('classic.SubagentStop', () => beneath)
    await $.session.start(SESSION)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder' } as never)
    await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_s2', subagentType: 'omelette-coder' } as never)
    reads.length = 0

    // A blocked stop: the agent runs on, nothing noted, and the record is not even read.
    beneath = { block: 'not yet' }
    await $.classic.SubagentStop({ ...STOP, agent_id: 'a1b2c3d4e5f6', agent_type: 'omelette-coder', cwd: CWD } as never)
    expect(nodeOf(world, 'a1b2c3d4e5f6')).toMatchObject({ status: 'running' })
    expect(nodeOf(world, 'a1b2c3d4e5f6')?.touched).toBeUndefined()

    // A role that is a path: nothing under it is read.
    beneath = {}
    await $.classic.SubagentStop({ ...STOP, agent_id: 'bbbb2222cccc', agent_type: '../../x', cwd: CWD } as never)
    expect(nodeOf(world, 'bbbb2222cccc')).toMatchObject({ status: 'reported' })
    expect(nodeOf(world, 'bbbb2222cccc')?.touched).toBeUndefined()
    expect(reads.filter(path => path.includes('..')), 'no read outside the reports').toEqual([])

    // No record on disk: the stop is noted, no line.
    await $.classic.SubagentStop({ ...STOP, agent_id: 'a1b2c3d4e5f6', agent_type: 'omelette-coder', cwd: '/home/op/elsewhere' } as never)
    expect(nodeOf(world, 'a1b2c3d4e5f6')).toMatchObject({ status: 'reported' })
    expect(nodeOf(world, 'a1b2c3d4e5f6')?.touched).toBeUndefined()

    // The record there: three files, read at the agent's own cwd.
    await $.classic.SubagentStop({ ...STOP, agent_id: 'a1b2c3d4e5f6', agent_type: 'omelette-coder', cwd: `${CWD}/` } as never)
    expect(nodeOf(world, 'a1b2c3d4e5f6')?.touched).toBe('touched: .omelette/reports/touched-omelette-coder-a1b2c3d4.md — 3 files')
  })
})

// tester 1.8.0 Task 8
describe('tester 1.8.0 Task 8: pins, the effort flag and the effort notice at the engine edge', () => {
  const CWD = SESSION.cwd
  const NOTICE = (v: string) => `CLAUDE_CODE_EFFORT_LEVEL=${v} is set: it overrides every agent definition's effort (rules, "Spawning sub-agents")`

  /** A rendered definition's frontmatter with the two lines the mod reads. */
  const definition = (role: string, model: string, effort: string, nl = '\n') =>
    ['---', `name: ${role}`, `model: ${model}`, `effort: ${effort}`, 'disallowedTools: Agent', '---', '', 'body', ''].join(nl)
  const PROJECT = (role: string) => `${CWD}/.claude/agents/${role}.md`
  const HOMEDIR = (role: string) => `${HOME}/.claude/agents/${role}.md`
  const FOUR = {
    [PROJECT('omelette-coder')]: definition('omelette-coder', 'claude-opus-5-5', 'xhigh'),
    [PROJECT('omelette-coder-medium')]: definition('omelette-coder-medium', 'claude-opus-5-5', 'medium'),
    [PROJECT('omelette-tester')]: definition('omelette-tester', 'claude-sonnet-5-5', 'high'),
    [PROJECT('omelette-reviewer')]: definition('omelette-reviewer', 'claude-opus-5-5', 'xhigh'),
  }

  type Seen = { models: (string | undefined)[]; calls: number; toasts: string[] }

  /** The engine beneath: each spawn's model as it arrived, a fresh agent id per spawn, the toasts raised. */
  /** The engine beneath answers the model it was given, as it resolves a full id (a spawn with none: opus). */
  function engineOf(on: On, answer: (n: number, model: string | undefined) => unknown = (n, model) => ({ model: model || 'claude-opus-5-5', agentId: `agent-${n}` })): Seen {
    const seen: Seen = { models: [], calls: 0, toasts: [] }

    on('agent.spawn', ($, e) => {
      seen.models.push(e.model)
      seen.calls += 1

      return answer(seen.calls, e.model) as never
    })
    on('ui.toast', ($, e) => {
      seen.toasts.push(e.text)

      return { value: undefined }
    })
    on('turn.step', async function* () {
      return STEPPED
    })

    return seen
  }

  async function started(on: On, files: Record<string, string>, env: Record<string, string> = {}, answer?: (n: number, model: string | undefined) => unknown) {
    const world = worldOf(on, { files })
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME, ...env })
    const seen = engineOf(on, answer)

    return { world, seen }
  }

  test('each of the four roles spawned on haiku reaches the engine with its own definition\'s id: one toast each, four pins', async ($, on) => {
    const { world, seen } = await started(on, FOUR)
    await $.session.start(SESSION)

    for (const role of ['omelette-coder', 'omelette-coder-medium', 'omelette-tester', 'omelette-reviewer']) {
      await $.agent.spawn({ ...SPAWN, subagentType: role, model: 'haiku' } as never)
    }

    expect(seen.models).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
    expect(seen.toasts).toEqual([
      'pinned omelette-coder to claude-opus-5-5',
      'pinned omelette-coder-medium to claude-opus-5-5',
      'pinned omelette-tester to claude-sonnet-5-5',
      'pinned omelette-reviewer to claude-opus-5-5',
    ])
    expect(world.fleet?.counts?.pins).toBe(4)
    expect(nodeOf(world, 'agent-3')).toMatchObject({ role: 'omelette-tester', pinned: { from: 'haiku', to: 'claude-sonnet-5-5' } })
  })

  test('no pin where the call names the definition\'s model: its id, its alias, or a definition that spells an alias', async ($, on) => {
    const files = { ...FOUR, [PROJECT('omelette-reviewer')]: definition('omelette-reviewer', 'opus', 'xhigh') }
    const { world, seen } = await started(on, files)
    await $.session.start(SESSION)

    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder-medium', model: 'opus' } as never)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder', model: 'claude-opus-5-5' } as never)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-tester', model: 'sonnet' } as never)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-reviewer', model: 'claude-opus-5-5' } as never)

    expect(seen.models).toEqual(['opus', 'claude-opus-5-5', 'sonnet', 'claude-opus-5-5'])
    expect(seen.toasts).toEqual([])
    expect(world.fleet?.counts?.pins).toBeUndefined()
  })

  test('another id of the same family is a pin, and a definition that spells an alias is pinned to the alias as written', async ($, on) => {
    const files = { ...FOUR, [PROJECT('omelette-reviewer')]: definition('omelette-reviewer', 'opus', 'xhigh') }
    const { seen } = await started(on, files)
    await $.session.start(SESSION)

    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder', model: 'claude-opus-4-6' } as never)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-reviewer', model: 'claude-opus-4-6' } as never)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder', model: 'inherit' } as never)

    expect(seen.models).toEqual(['claude-opus-5-5', 'opus', 'claude-opus-5-5'])
    expect(seen.toasts).toHaveLength(3)
  })

  test('a spawn by the main loop and one by a sub-agent are pinned alike; a fork, a missing or empty model and a non-guarded role are not', async ($, on) => {
    const { world, seen } = await started(on, FOUR)
    await $.session.start(SESSION)

    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder', model: 'haiku' } as never)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder', model: 'haiku', parentAgentId: 'agent-1' } as never)
    expect(seen.models).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])

    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder', model: 'haiku', fork: true } as never)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder', model: '' } as never)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder' } as never)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coders', model: 'haiku' } as never)
    await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose', model: 'haiku' } as never)
    expect(seen.models.slice(2)).toEqual(['haiku', '', undefined, 'haiku', 'haiku'])
    expect(seen.toasts).toHaveLength(2)
    expect(world.fleet?.counts?.pins).toBe(2)
  })

  test('a definition read through CRLF, quotes and trailing comments pins and flags as a plain one does', async ($, on) => {
    const crlf = ['---', 'name: omelette-coder', 'model: "claude-opus-5-5"  # pinned', 'effort: xhigh # note', '---', 'body', ''].join('\r\n')
    const { world, seen } = await started(on, { [PROJECT('omelette-coder')]: crlf })
    await $.session.start(SESSION)

    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder', model: 'haiku' } as never)
    expect(seen.models).toEqual(['claude-opus-5-5'])

    await step($ as never, 'agent-1', 'xhigh')
    expect(seen.toasts, 'the pin only: xhigh is the definition\'s').toEqual(['pinned omelette-coder to claude-opus-5-5'])
    await step($ as never, 'agent-1', 'low')
    expect(seen.toasts.at(-1)).toBe('effort low on omelette-coder (definition says xhigh)')
    expect(nodeOf(world, 'agent-1')?.effortFlag).toEqual({ effort: 'low', expected: 'xhigh' })
  })

  test('the project\'s definition wins over HOME\'s; a role only HOME has is read from HOME; with neither, no pin, no toast, no throw', async ($, on) => {
    const files = {
      [PROJECT('omelette-coder')]: definition('omelette-coder', 'claude-opus-5-5', 'xhigh'),
      [HOMEDIR('omelette-coder')]: definition('omelette-coder', 'claude-haiku-5-5', 'low'),
      [HOMEDIR('omelette-tester')]: definition('omelette-tester', 'claude-sonnet-5-5', 'high'),
    }
    const { seen } = await started(on, files)
    await $.session.start(SESSION)

    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder', model: 'haiku' } as never)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-tester', model: 'haiku' } as never)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-reviewer', model: 'haiku' } as never)

    expect(seen.models).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'haiku'])
    expect(seen.toasts).toEqual(['pinned omelette-coder to claude-opus-5-5', 'pinned omelette-tester to claude-sonnet-5-5'])
  })

  test('a spawn the engine refuses: no pin toast, no pin counted, no node, and the refusal comes back as it was', async ($, on) => {
    const { world, seen } = await started(on, FOUR, {}, () => ({ deny: 'no more agents' }))
    await $.session.start(SESSION)

    const result = await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder', model: 'haiku' } as never)

    expect(result).toEqual({ deny: 'no more agents' })
    expect(seen.models, 'the engine was asked once, with the pinned model').toEqual(['claude-opus-5-5'])
    expect(seen.toasts).toEqual([])
    expect(world.fleet?.counts?.pins).toBeUndefined()
    expect(world.fleet?.nodes.filter(node => node.role === 'omelette-coder') ?? []).toEqual([])
  })

  test('an engine answer that names the pin by its alias (or the alias\'s id) is a pin taken, not an override', async ($, on) => {
    const files = { ...FOUR, [PROJECT('omelette-reviewer')]: definition('omelette-reviewer', 'opus', 'xhigh') }
    const { world, seen } = await started(on, files, {}, (n, model) => ({ model: model === 'opus' ? 'claude-opus-5-5' : 'opus', agentId: `agent-${n}` }))
    await $.session.start(SESSION)

    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-reviewer', model: 'haiku' } as never)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder', model: 'haiku' } as never)

    expect(seen.models).toEqual(['opus', 'claude-opus-5-5'])
    expect(seen.toasts).toEqual(['pinned omelette-reviewer to opus', 'pinned omelette-coder to claude-opus-5-5'])
    expect(world.fleet?.counts?.pins).toBe(2)
  })

  test('a spawn answered without an agent id still counts the pin and toasts', async ($, on) => {
    const world = worldOf(on, { files: FOUR })
    mock.clock(on, { now: NOW })
    mock.env(on, { HOME })
    const seen = engineOf(on, () => ({ model: 'claude-opus-5-5' }))
    await $.session.start(SESSION)

    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder', model: 'haiku' } as never)

    expect(seen.toasts).toEqual(['pinned omelette-coder to claude-opus-5-5'])
    expect(world.fleet?.counts?.pins).toBe(1)
  })

  test('a step: the definition\'s effort flags nothing; a step with no effort, the main loop\'s, and an agent the pane never saw flag nothing', async ($, on) => {
    const { world, seen } = await started(on, FOUR)
    await $.session.start(SESSION)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder' } as never)

    await step($ as never, 'agent-1', 'xhigh')
    await step($ as never, undefined, 'low')
    await step($ as never, 'agent-ghost', 'low')
    const noEffort = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3, agentId: 'agent-1' } as never)
    for (let read = await noEffort.next(); !read.done; read = await noEffort.next());

    expect(seen.toasts).toEqual([])
    expect(nodeOf(world, 'agent-1')?.effortFlag).toBeUndefined()
  })

  test('a second differing step, even on another effort, says nothing more; another agent of the role is flagged on its own', async ($, on) => {
    const { world, seen } = await started(on, FOUR)
    await $.session.start(SESSION)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder' } as never)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-tester' } as never)

    await step($ as never, 'agent-1', 'low')
    await step($ as never, 'agent-1', 'max')
    await step($ as never, 'agent-2', 'xhigh')
    await step($ as never, 'agent-2', 'xhigh')

    expect(seen.toasts).toEqual(['effort low on omelette-coder (definition says xhigh)', 'effort xhigh on omelette-tester (definition says high)'])
    expect(nodeOf(world, 'agent-1')?.effortFlag).toEqual({ effort: 'low', expected: 'xhigh' })
    expect(nodeOf(world, 'agent-2')?.effortFlag).toEqual({ effort: 'xhigh', expected: 'high' })
  })

  test('a numeric effort is compared as its text; a definition with no effort line flags nothing', async ($, on) => {
    const files = {
      [PROJECT('omelette-coder')]: definition('omelette-coder', 'claude-opus-5-5', '8000'),
      [PROJECT('omelette-tester')]: ['---', 'name: omelette-tester', 'model: claude-sonnet-5-5', '---', ''].join('\n'),
    }
    const { seen } = await started(on, files)
    await $.session.start(SESSION)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder' } as never)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-tester' } as never)

    await step($ as never, 'agent-1', 8000)
    await step($ as never, 'agent-2', 'low')

    expect(seen.toasts).toEqual([])
  })

  for (const [set, said] of [['low', [NOTICE('low')]], ['  ', []], ['', []], ['  max ', [NOTICE('max')]]] as [string, string[]][]) {
    test(`the effort notice with the variable set to ${JSON.stringify(set)}: ${said.length ? 'said, trimmed' : 'nothing'}`, async ($, on) => {
      const { seen } = await started(on, {}, { CLAUDE_CODE_EFFORT_LEVEL: set })
      await $.session.start(SESSION)

      expect(seen.toasts).toEqual(said)
    })
  }

  test('a reload (a second session.start) says the notice again and keeps the row\'s effort flag to once', async ($, on) => {
    const { world, seen } = await started(on, FOUR, { CLAUDE_CODE_EFFORT_LEVEL: 'low' })
    await $.session.start(SESSION)
    await $.agent.spawn({ ...SPAWN, subagentType: 'omelette-coder' } as never)
    await step($ as never, 'agent-1', 'low')
    await $.session.start(SESSION)
    await step($ as never, 'agent-1', 'low')

    expect(seen.toasts.filter(text => text === NOTICE('low'))).toHaveLength(2)
    expect(seen.toasts.filter(text => text.startsWith('effort '))).toHaveLength(1)
    expect(nodeOf(world, 'agent-1')?.effortFlag).toEqual({ effort: 'low', expected: 'xhigh' })
  })
})

// tester 1.8.0 Task 9
describe('tester 1.8.0 Task 9: the handoff block, the one-copy strip and the compaction skip at the engine edge', () => {
  const CWD = '/home/op/work'
  const SCRIPT = `${CWD}/.claude/hooks/omelette-guard.mjs`
  const HOME_SCRIPT = `${HOME}/.claude/hooks/omelette-guard.mjs`
  const OMELETTE = `${CWD}/.omelette`
  const MARKER = '--- omelette-fleet · read before continuing ---'
  const PRINT = `${MARKER}\n--- ledger-x.md · last handoff ---\n## Handoff (2026-10-08 — x)\nnext: run npm test\n`
  const SKIP = 'no handoff in the last 30 minutes: write one, then compact again'
  const MIN = 60_000
  const COMPACTED = { messages: [{ role: 'user' as const, text: 'the summary', toolUses: [] }] }
  const MESSAGES = [{ role: 'user' as const, text: 'Implement Task 9', toolUses: [] }]
  const compact = (trigger: string, more: Record<string, unknown> = {}) => ({ trigger, messages: MESSAGES, ...more }) as never
  /** A local noon, so a heading 5 minutes old is never on another local day. */
  const NOON = new Date(2026, 9, 8, 12, 0).getTime()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = (at: number) => {
    const d = new Date(at)

    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const heading = (at: number) => `## Handoff (${stamp(at)} — written)`
  const ledgerOf = (branch: string | undefined, head: string) => [...(branch === undefined ? ['# ledger'] : ['# ledger', `branch: ${branch}`]), '', head, 'next: run npm test', ''].join('\n')

  type Entry = { text: string; mtimeMs: number; size?: number; isLink?: boolean; kind?: 'file' | 'directory' }
  type Spy = { gits: string[]; runs: number; nodeArgv: (readonly string[])[]; reads: string[]; compactions: number }

  function engine(on: On, { scripts = [SCRIPT], stdout = asJson(PRINT), exitCode = 0, ledgers = {}, branches = [], listFails = false }: { scripts?: string[]; stdout?: string; exitCode?: number; ledgers?: Record<string, Entry>; branches?: string[]; listFails?: boolean } = {}): Spy {
    const spy: Spy = { gits: [], runs: 0, nodeArgv: [], reads: [], compactions: 0 }

    on('session.cwd', () => ({ value: CWD }))
    on('fs.exists', ($, e) => ({ value: scripts.includes(e.path) }))
    on('fs.list', ($, e) =>
      listFails || e.path !== OMELETTE
        ? ({ deny: `ENOENT: ${e.path}` } as never)
        : { value: Object.entries(ledgers).map(([name, one]) => ({ name, kind: one.kind ?? ('file' as const), size: one.size ?? one.text.length, mtimeMs: one.mtimeMs, isLink: one.isLink ?? false })) },
    )
    on('fs.read', ($, e) => {
      spy.reads.push(e.path)
      const one = e.path.startsWith(`${OMELETTE}/`) ? ledgers[e.path.slice(OMELETTE.length + 1)] : undefined

      return one ? { value: one.text } : ({ deny: `ENOENT: ${e.path}` } as never)
    })
    on('process.run', ($, e) => {
      const run = e as { argv: readonly string[] }
      const exited = (code: number, out = '') => ({ value: { exitCode: code, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

      if (run.argv[0] === 'git') {
        const ref = String(run.argv[run.argv.length - 1])

        spy.gits.push(ref)

        return exited(branches.some(branch => ref === `refs/heads/${branch}`) ? 0 : 1)
      }

      spy.runs += 1
      spy.nodeArgv.push(run.argv)

      return exited(exitCode, stdout)
    })
    on('session.compact', () => {
      spy.compactions += 1

      return COMPACTED
    })

    return spy
  }

  const asJson = (text: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })

  // ---- the block

  test('a script that exits 1 with text on stdout adds no block', async ($, on) => {
    mock.clock(on, { now: NOON })
    mock.env(on, { HOME, PATH: '/opt/node/bin' })
    const spy = engine(on, { exitCode: 1, stdout: asJson(PRINT) })
    on('prompt.context', () => ({ blocks: [] }))

    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([])
    expect(spy.runs).toBe(1)
  })

  test('no rendered script anywhere: no block and no node run; the copy under HOME is found when the project has none', async ($, on) => {
    mock.clock(on, { now: NOON })
    mock.env(on, { HOME, PATH: '/opt/node/bin' })
    const none = engine(on, { scripts: [] })
    on('prompt.context', () => ({ blocks: [] }))

    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([])
    expect(none.runs).toBe(0)
  })

  test('the script under HOME is the one run when the project has none', async ($, on) => {
    mock.clock(on, { now: NOON })
    mock.env(on, { HOME, PATH: '/opt/node/bin' })
    const spy = engine(on, { scripts: [HOME_SCRIPT] })
    on('prompt.context', () => ({ blocks: [] }))

    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([{ name: 'omeletteHandoff', text: PRINT }])
    expect(spy.nodeArgv).toEqual([['node', HOME_SCRIPT]])
  })

  test('a PATH with no absolute entry: the script is not run and no block is added', async ($, on) => {
    mock.clock(on, { now: NOON })
    mock.env(on, { HOME, PATH: 'node_modules/.bin:bin' })
    const spy = engine(on)
    on('prompt.context', () => ({ blocks: [] }))

    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([])
    expect(spy.runs).toBe(0)
  })

  test('a JSON document with no additionalContext string delivers the stdout as it is, trimmed (the brief\'s fallback)', async ($, on) => {
    mock.clock(on, { now: NOON })
    mock.env(on, { HOME, PATH: '/opt/node/bin' })
    engine(on, { stdout: '{"hookSpecificOutput":{"hookEventName":"SessionStart"}}\n' })
    on('prompt.context', () => ({ blocks: [] }))

    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([{ name: 'omeletteHandoff', text: '{"hookSpecificOutput":{"hookEventName":"SessionStart"}}' }])
  })

  // ---- the strip

  test('the strip keeps the entries in their order, removes every marker-led one, and keeps one that only MENTIONS the marker', async ($, on) => {
    mock.env(on, { HOME })
    engine(on)
    const mentions = `a note quoting ${MARKER} in its middle`
    on('classic.SessionStart', () => ({ additionalContext: ['first', PRINT, mentions, `${MARKER}\nanother`, 'last'], sessionTitle: 't' }))

    expect(await $.classic.SessionStart({ source: 'compact', cwd: CWD } as never)).toEqual({ additionalContext: ['first', mentions, 'last'], sessionTitle: 't' })
  })

  test('resume and fork leave the engine\'s answer untouched, the marked entry included', async ($, on) => {
    mock.env(on, { HOME })
    engine(on)
    const beneath = { additionalContext: [PRINT, 'other'] }
    on('classic.SessionStart', () => beneath)

    for (const source of ['resume', 'fork']) {
      expect(await $.classic.SessionStart({ source, cwd: CWD } as never), source).toEqual(beneath)
    }
  })

  test('a result with no additionalContext passes as it is; the script under HOME alone licenses the strip', async ($, on) => {
    mock.env(on, { HOME })
    engine(on, { scripts: [HOME_SCRIPT] })
    on('classic.SessionStart', ($, e) => ((e as { source: string }).source === 'clear' ? { sessionTitle: 'only' } : { additionalContext: [PRINT, 'kept'] }))

    expect(await $.classic.SessionStart({ source: 'clear', cwd: CWD } as never)).toEqual({ sessionTitle: 'only' })
    expect(await $.classic.SessionStart({ source: 'compact', cwd: CWD } as never)).toEqual({ additionalContext: ['kept'] })
  })

  // ---- the gate

  const GATE = { options: { handoffGate: true } }

  test('the allowance window: a compaction 9 min 59 s after the skip passes, one 10 min 1 s after it is skipped again, and that skip opens a new window', GATE, async ($, on) => {
    const clock = mock.clock(on, { now: NOON })
    engine(on, { ledgers: { 'ledger-x.md': { text: ledgerOf('main', '## Handoff (2020-01-01 — old)'), mtimeMs: NOON } } })

    expect(await $.session.compact(compact('auto'))).toEqual({ skip: SKIP })
    await clock.advance(10 * MIN - 1000)
    expect(await $.session.compact(compact('auto')), 'inside the window').toEqual(COMPACTED)
    await clock.advance(2000)
    expect(await $.session.compact(compact('auto')), 'past the window, skipped again').toEqual({ skip: SKIP })
    await clock.advance(MIN)
    expect(await $.session.compact(compact('auto')), 'the new window, opened by the second skip').toEqual(COMPACTED)
  })

  test('the skip does not call the engine beneath; a pass does', GATE, async ($, on) => {
    mock.clock(on, { now: NOON })
    const spy = engine(on, { ledgers: { 'ledger-x.md': { text: ledgerOf('main', '## Handoff (2020-01-01 — old)'), mtimeMs: NOON } } })

    await $.session.compact(compact('manual'))
    expect(spy.compactions).toBe(0)
    await $.session.compact(compact('manual'))
    expect(spy.compactions).toBe(1)
  })

  test('precompute and plugin compactions pass AND leave the allowance unspent: the next manual one is still skipped', GATE, async ($, on) => {
    mock.clock(on, { now: NOON })
    const spy = engine(on, { ledgers: { 'ledger-x.md': { text: ledgerOf('main', '## Handoff (2020-01-01 — old)'), mtimeMs: NOON } } })

    expect(await $.session.compact(compact('precompute'))).toEqual(COMPACTED)
    expect(await $.session.compact(compact('plugin'))).toEqual(COMPACTED)
    expect(await $.session.compact(compact('auto', { agentId: 'agent-c1' }))).toEqual(COMPACTED)
    expect(spy.gits).toEqual([])
    expect(await $.session.compact(compact('manual'))).toEqual({ skip: SKIP })
  })

  test('a fresh heading with a time 5 minutes old passes, spends no allowance, and a heading 31 minutes old is skipped', GATE, async ($, on) => {
    mock.clock(on, { now: NOON })
    const ledgers: Record<string, Entry> = { 'ledger-x.md': { text: ledgerOf('main', heading(NOON - 5 * MIN)), mtimeMs: NOON } }
    engine(on, { ledgers })
    expect(await $.session.compact(compact('manual'))).toEqual(COMPACTED)
    ledgers['ledger-x.md'] = { text: ledgerOf('main', heading(NOON - 31 * MIN)), mtimeMs: NOON }
    expect(await $.session.compact(compact('manual')), 'the earlier pass did not use the allowance').toEqual({ skip: SKIP })
  })

  test('only the NEWEST open ledger decides: a stale newest beside a fresh older one skips; a fresh newest beside a stale older one passes', GATE, async ($, on) => {
    const clock = mock.clock(on, { now: NOON })
    const ledgers: Record<string, Entry> = {
      'ledger-old.md': { text: ledgerOf('main', heading(NOON - 2 * MIN)), mtimeMs: NOON - 90 * MIN },
      'ledger-new.md': { text: ledgerOf('main', '## Handoff (2020-01-01 — stale)'), mtimeMs: NOON - 60 * MIN },
    }
    engine(on, { ledgers })
    expect(await $.session.compact(compact('manual'))).toEqual({ skip: SKIP })
    ledgers['ledger-new.md'] = { text: ledgerOf('main', heading(NOON - 2 * MIN)), mtimeMs: NOON - 60 * MIN }
    ledgers['ledger-old.md'] = { text: ledgerOf('main', '## Handoff (2020-01-01 — stale)'), mtimeMs: NOON - 90 * MIN }
    await clock.advance(11 * MIN)
    expect(await $.session.compact(compact('manual'))).toEqual(COMPACTED)
  })

  test('a branch name git is never handed (a shell metacharacter, 129 characters) closes the ledger with no git run; so no open ledger passes', GATE, async ($, on) => {
    mock.clock(on, { now: NOON })
    const stale = '## Handoff (2020-01-01 — stale)'
    const spy = engine(on, {
      ledgers: {
        'ledger-a.md': { text: ledgerOf('feat/x;touch pwned', stale), mtimeMs: NOON },
        'ledger-b.md': { text: ledgerOf(`f${'x'.repeat(128)}`, stale), mtimeMs: NOON },
        'ledger-c.md': { text: ledgerOf('$(id)', stale), mtimeMs: NOON },
      },
    })
    expect(await $.session.compact(compact('manual'))).toEqual(COMPACTED)
    expect(spy.gits).toEqual([])
  })

  test('a headerless ledger counts as open with no git run (stale: skipped)', GATE, async ($, on) => {
    mock.clock(on, { now: NOON })
    const spy = engine(on, { ledgers: { 'ledger-h.md': { text: ledgerOf(undefined, '## Handoff (2020-01-01 — stale)'), mtimeMs: NOON } } })
    expect(await $.session.compact(compact('manual'))).toEqual({ skip: SKIP })
    expect(spy.gits).toEqual([])
  })

  test('only regular ledger-*.md files count: a link, a directory, notes.md and ledger-x.txt are ignored (a fresh one of them beside a stale open ledger skips)', GATE, async ($, on) => {
    mock.clock(on, { now: NOON })
    const fresh = ledgerOf('main', heading(NOON - MIN))
    engine(on, {
      ledgers: {
        'ledger-real.md': { text: ledgerOf('main', '## Handoff (2020-01-01 — stale)'), mtimeMs: NOON - 60 * MIN },
        'ledger-link.md': { text: fresh, mtimeMs: NOON, isLink: true },
        'ledger-dir.md': { text: fresh, mtimeMs: NOON, kind: 'directory' },
        'notes.md': { text: fresh, mtimeMs: NOON },
        'ledger-x.txt': { text: fresh, mtimeMs: NOON },
      },
    })

    expect(await $.session.compact(compact('manual'))).toEqual({ skip: SKIP })
  })

  test('a listing that fails: no open ledger, the compaction passes', GATE, async ($, on) => {
    mock.clock(on, { now: NOON })
    engine(on, { listFails: true })
    expect(await $.session.compact(compact('manual'))).toEqual(COMPACTED)
  })

  test('a ledger over the 4 MiB read bound is stale without being read, and never skips the gate for want of a read', GATE, async ($, on) => {
    mock.clock(on, { now: NOON })
    const spy = engine(on, { ledgers: { 'ledger-big.md': { text: ledgerOf('main', heading(NOON - MIN)), mtimeMs: NOON, size: 4 * 1024 * 1024 + 1 } } })

    expect(await $.session.compact(compact('manual'))).toEqual({ skip: SKIP })
    expect(spy.reads).toEqual([])
  })
})
