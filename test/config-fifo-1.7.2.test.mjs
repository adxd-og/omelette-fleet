// 1.7.2 review round 2: fleet.config.json is read through one O_NOFOLLOW | O_NONBLOCK fd
// (core/status.mjs readRegularFile), so a FIFO at its name — or a link to one — cannot hold
// the server's start or a tool call. The read runs in a child under a timeout: the old
// by-name readFileSync waits for a writer that never comes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const posix = process.platform !== 'win32';

for (const [how, plant] of [
  ['a FIFO at fleet.config.json', (home, fifo) => execFileSync('mkfifo', [join(home, 'fleet.config.json')])],
  ['a link to a FIFO at fleet.config.json', (home, fifo) => symlinkSync(fifo, join(home, 'fleet.config.json'))],
]) {
  test(`loadFleetConfig: ${how} does not hold the load; it reports an error and no config`, { skip: !posix && 'POSIX FIFOs' }, () => {
    const home = mkdtempSync(join(tmpdir(), 'omelette-config-fifo-'));
    const fifo = join(mkdtempSync(join(tmpdir(), 'omelette-fifo-')), 'pipe');
    execFileSync('mkfifo', [fifo]);
    plant(home, fifo);
    const code = `import { loadFleetConfig } from ${JSON.stringify(new URL('../core/config.mjs', import.meta.url).href)};
const r = loadFleetConfig({ OMELETTE_HOME: ${JSON.stringify(home)} });
console.log(JSON.stringify({ config: r.config, error: r.error }));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 5000, encoding: 'utf8' });
    assert.equal(r.error, undefined, 'the load must not wait on the FIFO');
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.config, null);
    // The FIFO itself opens (O_NONBLOCK) and fails the regular-file check; the link is refused by O_NOFOLLOW with the OS's ELOOP.
    assert.match(String(out.error), /not a regular file|ELOOP/);
  });
}
