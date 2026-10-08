// The `$.state` contract of the fleet pane: one value, `omelette-fleet.fleet`,
// the fleet model of hooks/model.mjs (its JSDoc typedefs are these types).

export type FleetNode = {
  id: string
  kind: 'orchestrator' | 'agent' | 'unit'
  role: string
  parentId?: string
  model?: string
  effort?: string
  status: 'running' | 'waiting' | 'idle' | 'reported'
  activity?: string
  activityCallId?: string
  since: number
  callerId?: string
  feed?: 'ok' | 'none'
  lastEndedAt?: number
  order: number
  /** A unit's calls of this session still out; the unit shows the newest. */
  openCalls?: { callId: string; callerId: string; tool: string; since: number }[]
}

/** Node ids, or a SendMessage's raw target. */
export type FleetLink = { at: number; from: string; to: string; label: string }

export type FleetUsage = { contextPercent?: number; fiveHour?: number; sevenDay?: number; costUsd?: number }

export type FleetState = { nodes: FleetNode[]; history: FleetLink[]; usage: FleetUsage; now: number; isOpen: boolean }

declare module 'claude-code' {
  interface PluginState {
    'omelette-fleet': { fleet: FleetState }
  }
}
