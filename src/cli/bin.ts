#!/usr/bin/env node
/** @module Command-line entry: reads and writes flags through the flags file and the admin API of a running server. */
import * as Fs from 'node:fs'
import { Cli } from 'incur'
import dev from './commands/dev.js'
import * as Local from './commands/local.js'
import * as Remote from './commands/remote.js'
import retire from './commands/retire.js'

// `src/cli/bin.ts` and `dist/cli/bin.js` both lie two directories below the package root.
const version = (() => {
  try {
    const manifest = JSON.parse(
      Fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
})()

const cli = Cli.create('flargs', {
  description:
    'Reads and writes feature flags through the flags file and the admin API of a Flargs server.',
  // The CLI runs in CI, so Incur's background update check stays off.
  update: false,
  version,
})
  .command('check', Local.check)
  .command('define', Remote.define)
  .command('dev', dev)
  .command('generate', Local.generate)
  .command('get', Remote.get)
  .command('link', Remote.link)
  .command('list', Remote.list)
  .command('prune', Remote.prune)
  .command('retire', retire)
  .command('set', Remote.set)
  .command('stale', Local.stale)
  .command('undefine', Remote.undefine)
  .command('unset', Remote.unset)

await cli.serve()
