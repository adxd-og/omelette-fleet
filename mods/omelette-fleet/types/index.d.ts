// The `$.state` contract of the fleet pane: one value, `omelette-fleet.fleet`.
// Its type is filled in with the fleet model (1.7.0, Task 2).

declare module 'claude-code' {
  interface PluginState {
    'omelette-fleet': { fleet: unknown }
  }
}
