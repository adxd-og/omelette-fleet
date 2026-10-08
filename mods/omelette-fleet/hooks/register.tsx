/**
 * omelette-fleet :: mods/omelette-fleet/hooks/register.tsx
 * The fleet pane's hooks module: the one file of the mod that calls `$` and
 * draws. This is the skeleton (1.7.0, Task 1): `/omelette-fleet` opens the
 * pane (`/omelette-fleet close` closes it), and the pane says there is no
 * fleet activity yet.
 *
 * `$` is always spelled `$.noun.method(...)` literally: the engine scans this
 * source and refuses a call it did not see.
 */
import type { Register } from 'claude-code'

const PANE = 'omelette-fleet'
const TITLE = 'Fleet'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'omelette-fleet',
      description: 'Show the fleet: agents, units and who is calling whom',
      argumentHint: '[close]',
    })

    return next(e)
  })

  // Answers its own command: one line of text, never `next`.
  on('command.run', { command: 'omelette-fleet' }, async ($, e) => {
    if (e.args.trim() === 'close') {
      await $.ui.close({ id: PANE })

      return { text: 'Fleet pane closed.' }
    }

    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return { text: opened.isPlaced ? 'Fleet pane opened.' : `Fleet pane waits: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text dimColor>No fleet activity yet.</Text>
  })
}
