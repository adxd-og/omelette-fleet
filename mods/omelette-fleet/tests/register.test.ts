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
