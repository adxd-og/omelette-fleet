/**
 * omelette-fleet :: mods/omelette-fleet/tests/tester-t3.test.ts
 * Tester's kit tests for 1.7.0 Task 4 (the desktop drawing) (run by `claude plugin test`, never by `npm test`): the pane
 * drawn on a surface that draws an Svg, from the plan's Task 4 and the rulings. Paths and ids are made up.
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
