/**
 * omelette-fleet :: mods/omelette-fleet/tests/tester-t3-2.test.ts
 * Tester's kit tests for 1.7.0 Task 3.2 (run by `claude plugin test`, never by `npm test`): what the
 * motion's rulings leave to a mutant in the tick — which actors move it, how often the feed is
 * read, one chain at a time, no fast tick before a draw — and the option reaching the desktop's SVG.
 * Paths and ids are made up.
 */
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderInput, SessionStartInput } from 'claude-code'

const PLUGIN = 'omelette-fleet'
const NOW = Date.UTC(2026, 9, 8, 9, 0, 0)
const SESSION: SessionStartInput = { cwd: '/home/op/work', surface: 'terminal', isInteractive: true }
const HOME = '/home/op'

type World = { panes: { id: string; isPlaced: boolean }[]; asks: number; lists: number }

/** The engine beneath the plugin, in memory: panes, and how often the plugin asks for them and lists the fleet home. */
function worldOf(on: On): World {
  const world: World = { panes: [], asks: 0, lists: 0 }

  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1_000_000, percent: 31 }, rateLimits: [], cost: { usd: 3 } } }))
  on('ui.open', ($, e) => {
    if (!world.panes.some(pane => pane.id === e.id)) {
      world.panes.push({ id: e.id, isPlaced: true })
    }

    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    world.panes = world.panes.filter(pane => pane.id !== e.id)

    return { value: undefined }
  })
  on('ui.panes', () => {
    world.asks += 1

    return { value: world.panes.map(pane => ({ ...pane, title: 'Fleet', isShown: true, isFocused: false })) }
  })
  on('ui.status', () => ({ value: undefined }))
  on('fs.list', () => {
    world.lists += 1

    return { value: [] } as never
  })
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
const UNIT_RESULT = { result: { content: [{ type: 'text', text: 'two findings' }] }, text: 'two findings' }

/** How many times the plugin asked for the panes in the next `ms`. */
async function asksIn(clock: { advance: (ms: number) => Promise<void> }, world: World, ms: number): Promise<number> {
  const before = world.asks

  await clock.advance(ms)

  return world.asks - before
}

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
