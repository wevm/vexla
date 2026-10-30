#!/usr/bin/env node
/** @module Command-line entry: reads and writes flags through the admin API of a running server. */
import { Cli } from 'incur'

const cli = Cli.create('flargs', {
  description: 'Reads and writes feature flags through the admin API of a Flargs server.',
  // The CLI runs in CI, so Incur's background update check stays off.
  update: false,
})

await cli.serve()
